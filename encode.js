var Int64 = require('node-int64')
var Int53 = require('int53')
var varint = require('varint')
//encode an empty parquet file.
//should be like this:

/*
PAR1
<FileMetadata>
<length(FileMetaData)>
PAR1
*/

var BufferList = require('bl')

var thrift = require('thrift')
var pt = require('./gen-nodejs/parquet_types')

function plain(value) {
  var v = new Buffer(value)
  var len = new Buffer(4)
  len.writeUInt32LE(v.length, 0)
  return Buffer.concat([len, v])
}

//value must be a thrift type.
function encode(value) {
  var output = []
  var transport = new thrift.TBufferedTransport(null, function (buf) {
    output.push(buf)
  })
  var protocol = new thrift.TCompactProtocol(transport)
  value.write(protocol)
  transport.flush()
  return Buffer.concat(output)
}

function encodeRepeats(repeats, value) {
  var len = varint.encodingLength(repeats << 1)
  var b = new Buffer(4 + len + 1)
  b.writeUInt32LE(len+1, 0)
  varint.encode(repeats << 1, b, 4)
  b[4 + len] = value
  return b
}

var encodeValues = {
  BYTE_ARRAY: function (column) {
    return Buffer.concat([
      //these 6 bytes are actually a hybrid RLE, it seems of the repetition level?
      //the column starts with a hybrid-rle/bitpack of the definition
      //level. for a flat schema with all fields, that is the
      //same as a lot of 1's. that can be encoded most compactly
      //as a RLE.

      //Question: how is the bitwidth of the RLE calculated?
      //I'm guessing it's something in the schema?
//      encodeRepeats(column.length, 1)
    ].concat(column.map(plain)))

  },
  INT32: function (column) {
    var b = new Buffer(4*column.length)
    for(var i = 0; i < column.length; i++)
      b.writeInt32LE(column[i], i*4)
    return b
  },
  INT64: function (column) {
    var b = new Buffer(8*column.length)
    for(var i = 0; i < column.length; i++)
      Int53.writeUInt64LE(column[i], b, i*8)
    return b
  },
  FLOAT: function (column) {
    var b = new Buffer(4*column.length)
    for(var i = 0; i < column.length; i++)
      b.writeFloatLE(column[i], i*4)
    return b
  },
  DOUBLE: function (column) {
    var b = new Buffer(8*column.length)
    for(var i = 0; i < column.length; i++)
      b.writeDoubleLE(column[i], i*8)
    return b
  }
}

function encodeColumn(name, type, column) {
  console.error(name, type, column)
  var values = encodeValues[type](column)

  var ph = new pt.PageHeader()

  ph.type = '0' //plain encoding
  ph.uncompressed_page_size = values.length
  ph.compressed_page_size = values.length
  ph.crc = null
  ph.data_page_header = new pt.DataPageHeader()
  ph.data_page_header.num_values = column.length
  ph.data_page_header.encoding = '0'   //plain encoding
  ph.data_page_header.definition_level_encoding = 3 //3 //RLE encoding
  ph.data_page_header.repetition_level_encoding = 4 //Bitpacked encoding
  //statistics is optional, but leaving it off probably slows
  //some queries.
  //ph.data_page_header.statistics

  var data_page = Buffer.concat([
    //unfortunately, the page header
    //is expected before the values
    //which means we can't stream the values
    //then write the header...
    //but I guess the idea is to write a column_chunk at a time
    //(with a page_header at the top)
    encode(ph),
    values
  ])

  return data_page
}

module.exports = function (headers, types, table) {
  var PAR1 = new Buffer("PAR1")
  var buf = new BufferList()
  buf.append(PAR1)

  var count = table.length

  var fmd = new pt.FileMetaData()
  var _schema = new pt.SchemaElement()
  _schema.name = 'hive_schema'
  _schema.num_children = headers.length

  var schemas = headers.map(function (name, i) {
    var schema = new pt.SchemaElement()
    schema.name = name
    schema.type = pt.Type[types[i]]
    schema.repetition_type = '0'
    //note, javascript code generated by thrift does not check
    //falsey values correctly, but parquet uses an old version of thrift
    //so it's easier to set it like this.
    schema.converted_type =
      types[i] === 'BYTE_ARRAY' ? '0' : null
//    : types[i] === 'INT32' ? null //17
//    : types[i] === 'INT64' ? 9 //timestamp millis
//    : null

    return schema
  })

  var columns = []

  table.forEach(function (row) {
    row.forEach(function (value, i) {
      columns[i] = columns[i] || []
      columns[i].push(value)
    })
  })

  var column_chunks = headers.map(function (name, i) {
    var data_page = encodeColumn(name, types[i], columns[i])
    var column = new pt.ColumnChunk()
    var metadata = new pt.ColumnMetaData()

    column.file_offset = new Int64(buf.length) 
    column.meta_data = metadata
    var start = buf.length
    buf.append(data_page) //APPEND this column.

    metadata.type = pt.Type[types[i]]
    metadata.encodings = types[i] == 'BYTE_ARRAY' ? [2, 4, 3] : [3, 4, 2]
    metadata.path_in_schema = [name]
    console.error(metadata)
    // must set the number as a string,
    // because parquet does not check null properly
    // and will think the value is not provided if
    // it is falsey (includes zero)

    metadata.codec = '0'
    metadata.num_values = count
    metadata.total_uncompressed_size = new Int64(data_page.length)
    metadata.total_compressed_size = new Int64(data_page.length)
    metadata.data_page_offset = new Int64(start) //just after PAR1

    return column
  })

  //the name "row group" suggests that a row group
  //should contain a column chunk for every row.
  //basically, we stream the input out chunks, a row group at a time.
  //these can be streamed to a file... we just save the file metadata
  //to be written at the end.

  var row_group = new pt.RowGroup()
  //row group has
  // - columns
  // - total_byte_size
  // - num_rows
  // - sorting_columns

  // with multiple columns, these will be one after another obviously.
  // for the first data_page, file_offset will be 4.
  // starts just after the "PAR1" magic number.

  row_group.columns = column_chunks
  row_group.num_rows = count
  row_group.total_byte_size = new Int64(buf.length - 4)

  fmd.version = 1
  fmd.schema = [_schema].concat(schemas)
  fmd.num_rows = count
  fmd.row_groups = [row_group]
  fmd.created_by = 'parquet.js@'+require('./package.json').version 

  var _output = encode(fmd)
  var len = new Buffer(4)
  len.writeUInt32LE(_output.length, len)

  buf.append(_output)
  buf.append(len)
  buf.append(PAR1)

  return buf.slice(0, buf.length) //copy the buffer
}

if(!module.parent)
  process.stdout.write(module.exports(
//    ['a', 'b', 'c', 'd'],
//    ['BYTE_ARRAY', 'INT32', "INT64", "FLOAT"],
//    [
//      ['one',   10, Date.now(), Math.random()],
//      ['two',   20, Date.now()+1000, Math.random()],
//      ['three', 30, Date.now()+10000, Math.random()],
//      ['four',  40, Date.now()+100000, Math.random()],
//      ['five',  50, Date.now()+1000000, Math.random()]
//    ]
    ['a', 'b', 'c'],
    ['BYTE_ARRAY', 'INT32', "INT64"],
    [
      ['one',   10, Date.now()],
      ['two',   20, Date.now()+1000],
      ['three', 30, Date.now()+10000],
      ['four',  40, Date.now()+100000],
      ['five',  50, Date.now()+1000000]
    ]
  ))

