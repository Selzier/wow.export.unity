const debug = require('debug')('TGA');

// doc: http://paulbourke.net/dataformats/tga/
//  v2: http://www.opennet.ru/docs/formats/targa.pdf
class TGA {
    constructor(buffer, opt) {
        debug('constructor');
        opt = Object.assign({ isFlipY: true }, opt);
        this.buffer = buffer;
        this.isFlipY = opt.isFlipY;
        this.parse();
    }
    static createTgaBuffer(width, height, pixels, dontFlipY) {
        debug('createTgaBuffer');
        // writeInt8 = byte
        // writeInt16LE = 2 bytes
        // writeInt32LE = 4 bytes
        var sizeExtension = 0; // Extension area should be an exact size if used. 495 bytes
        var sizeFooter = 26; // Footer is 26 bytes exactly

        var buffer = Buffer.alloc(18 + pixels.length + sizeExtension + sizeFooter);
        // write header
        buffer.writeInt8(0, 0); // Length of the Image Identification Field
        buffer.writeInt8(0, 1); // Color Map Type 
        buffer.writeInt8(2, 2); // Image Type Code. 
        // Color Map Specification.
        buffer.writeInt16LE(0, 3); // Color Map Origin. 
        buffer.writeInt16LE(0, 5); // Color Map Length.
        buffer.writeInt8(0, 7); // Color Map Entry Size. 
        // Image Specification
        buffer.writeInt16LE(0, 8); // X Origin of Image.
        buffer.writeInt16LE(0, 10); // Y Origin of Image.
        buffer.writeInt16LE(width, 12); // Width of Image.
        buffer.writeInt16LE(height, 14); // Height of Image.
        buffer.writeInt8(32, 16); // Image Pixel Size.  
        buffer.writeInt8(0, 17); //Image Descriptor Byte.

        var offsetImageData = 18;        
        for (var i = 0; i < height; i++) {
            for (var j = 0; j < width; j++) {
                var idx = ((dontFlipY ? i : height - i - 1) * width + j) * 4;
                buffer.writeUInt8(pixels[idx + 2], offsetImageData++); // b
                buffer.writeUInt8(pixels[idx + 1], offsetImageData++); // g
                buffer.writeUInt8(pixels[idx + 0], offsetImageData++); // r
                buffer.writeUInt8(pixels[idx + 3], offsetImageData++); // a
            }
        }

        console.log("OffsetImageData: " + offsetImageData);
        console.log("18plusPixelsLen: " + (18 + pixels.length));
        // Save offset positions for each section
        var offsetExtension = offsetImageData;        
        
        console.log("offsetExtension: " + offsetExtension);
        var offsetFooter = offsetExtension + sizeExtension;
        
        console.log("offsetFooter: " + offsetFooter);

        // Extension Area
        // Extension Size - Field 10 (2 Bytes)
        // Author Name - Field 11 (41 Bytes):
        // Author Comments - Field 12 (324 Bytes):
        // Date/Time Stamp - Field 13 (12 Bytes):
        // Job Name/ID - Field 14 (41 Bytes):
        // Job Time - Field 15 (6 Bytes):
        // Software ID - Field 16 (41 Bytes):
        // Software Version - Field 17 (3 Bytes):
        // Key Color - Field 18 (4 Bytes):
        // Pixel Aspect Ratio - Field 19 (4 Bytes):
        // Gamma Value - Field 20 (4 Bytes):
        // Color Correction Offset - Field 21 (4 Bytes):
        // Postage Stamp Offset - Field 22 (4 Bytes):
        // Scan Line Offset - Field 23 (4 Bytes):
        // Attributes Type - Field 24 (1 Byte):  <<<---- Alpha Channel
        // Scan Line Table - Field 25 (Variable):
        // Postage Stamp Image - Field 26 (Variable):
        // Color Correction Table - Field 27 (2K Bytes):

        /* TGA File Footer
        This is accomplished by examining the last 26 bytes of the file (most operating systems support some type of SEEK function).
        Reading the last 26 bytes from the file will either retrieve the last 26 bytes of image data (if the file is in the Original
        TGA Format), or it will retrieve the TGA File Footer (if the file is in the New TGA Format).
        
        To determine whether the acquired data constitutes a legal TGA File Footer, scan bytes 8-23 of the footer as ASCII characters
        and determine whether they match the signature string: TRUEVISION-XFILE
        
        therefore, the byte format for the TGA File Footer is defined as follows:
            
            Bytes 0-3: The Extension Area Offset
            Bytes 4-7: The Developer Directory Offset
            Bytes 8-23: The Signature
            Byte 24: ASCII Character “.”
            Byte 25: Binary zero string terminator (0x00)

        */
        // Byte 0-3 - Extension Area Offset - Field 28:
        // The first four bytes (bytes 0-3, the first LONG) contains an offset from the beginning of the file to the start of the Extension
        buffer.writeInt32LE(offsetExtension, offsetFooter + 0);
        
        // Byte 4-7 - Developer Directory Offset - Field 29
        // The next four bytes (bytes 4-7, the second LONG) contain an offset from the beginning of the file to the start of the Developer Directory.
        // If the Developer Directory Offset is zero, then the Developer Area does not exist.
        buffer.writeInt32LE(0, offsetFooter + 4);
        
        // Byte 8-23 - Signature - Field 30
        // This string is exactly 16 bytes long and is formatted exactly as shown above (capital letters), with a hyphen between “TRUEVISION”
        // and “XFILE.” If the signature is detected, the file is assumed to be in the New TGA format and MAY, therefore, contain the
        // Developer Area and/or the Extension Area fields. If the signature is not found, then the file is assumed to be in the Original TGA
        // format and should only contain areas 1 and 2 (Header & Image Data); 
        buffer.write("TRUEVISION-XFILE", offsetFooter + 8, 16, "ascii",); // *** I don't know if ascii is right ***

        // Byte 24 - Reserved Character - Field 31
        // Byte 24 is an ASCII character “.” (period). This character MUST BE a period or the file is not considered a proper TGA file.
        buffer.write(".", offsetFooter + 24, 1, "ascii",);
        
        // Byte 25 - Binary Zero String Terminator - Field 32
        // Byte 25 is a binary zero which acts as a final terminator and allows the entire TGA File Footer to be read and utilized as a “C” string.
        buffer.write("\0", offsetFooter + 25, 1, "ascii",); // *** Not sure if /0 is correct here but should be ***

        return buffer;
    }
    static getHeader(buffer) {
        debug('getHeader');
        var header = {};
        header.idlength = buffer.readInt8(0);
        header.colourMapType = buffer.readInt8(1);
        header.dataTypeCode = buffer.readInt8(2);
        header.colourMapOrigin = buffer.readInt16LE(3);
        header.colourMapLength = buffer.readInt16LE(5);
        header.colourMapDepth = buffer.readInt8(7);
        header.xOrigin = buffer.readInt16LE(8);
        header.yOrigin = buffer.readInt16LE(10);
        header.width = buffer.readInt16LE(12);
        header.height = buffer.readInt16LE(14);
        header.bitsPerPixel = buffer.readInt8(16);
        header.imageDescriptor = buffer.readInt8(17);
        debug('getHeader', header);
        return header;
    }
    parse() {
        debug('parse');
        this.header = this.readHeader();
        if (!this.check()) {
            return;
        }
        this.readPixels();
    }
    readHeader() {
        debug('readHeader');
        var header = TGA.getHeader(this.buffer);
        this.width = header.width;
        this.height = header.height;
        this.bytesPerPixel = header.bytesPerPixel = header.bitsPerPixel / 8;
        debug('readHeader', header);
        return header;
    }
    check() {
        debug('check tga file');
        var header = this.header;
        /* What can we handle */
        if (header.dataTypeCode != 2 && header.dataTypeCode != 10) {
            console.error('Can only handle image type 2 and 10');
            return false;
        }
        if (header.bitsPerPixel != 16 && 
            header.bitsPerPixel != 24 && header.bitsPerPixel != 32) {
            console.error('Can only handle pixel depths of 16, 24, and 32');
            return false;
        }
        if (header.colourMapType != 0 && header.colourMapType != 1) {
            console.error('Can only handle colour map types of 0 and 1');
            return false;
        }
        return true;
    }
    addPixel(arr, offset, idx) {
        if (this.isFlipY) {
            var y = this.height - 1 - Math.floor(idx / this.width);
            idx = y * this.width + idx % this.width;
        }
        idx *= 4;
        var count = this.bytesPerPixel;
        var r = 255;
        var g = 255;
        var b = 255;
        var a = 255;
        if (count === 3 || count === 4) {
            r = arr[offset + 2];
            g = arr[offset + 1];
            b = arr[offset];
            a = count === 4 ? arr[offset + 3] : 255;
        } else if (count === 2) {
            r = (arr[offset + 1] & 0x7c) << 1;
            g = ((arr[offset + 1] & 0x03) << 6) | ((arr[offset] & 0xe0) >> 2);
            b = (arr[offset] & 0x1f) << 3;
            a = (arr[offset + 1] & 0x80);
        } else {
            console.error('cant transform to Pixel');
        }

        this.pixels[idx] = r;
        this.pixels[idx + 1] = g;
        this.pixels[idx + 2] = b;
        this.pixels[idx + 3] = a;
    }
    readPixels() {
        debug('readPixels');
        var header = this.header;
        var bytesPerPixel = header.bytesPerPixel;
        var pixelCount = header.width * header.height;
        var data = new Uint8ClampedArray(this.buffer); // Data includes header
        this.pixels = new Uint8ClampedArray(pixelCount * 4); // pixels are just the imageData.data
        var offset = 18;

        for (var i = 0; i < pixelCount; i++) {
            if (header.dataTypeCode === 2) {
                this.addPixel(data, offset, i);
            } else if (header.dataTypeCode === 10) {
                var flag = data[offset++];
                var count = flag & 0x7f;
                var isRLEChunk = flag & 0x80;
                this.addPixel(data, offset, i);
                for (var j = 0; j < count; j++) {
                    if (!isRLEChunk) {
                        offset += this.bytesPerPixel;
                    }
                    this.addPixel(data, offset, ++i);
                }
            }
            offset += this.bytesPerPixel;
        }
    }
}

module.exports = TGA;