/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com> | Selzier 
	License: MIT
	Build: node ./build.js win-x64
 */
const util = require('util');
const core = require('../../core');
const path = require('path');
const fsp = require('fs').promises;
const constants = require('../../constants');
const generics = require('../../generics');
const listfile = require('../../casc/listfile');
const log = require('../../log');
const fs = require('fs');

const BufferWrapper = require('../../buffer');
const BLPFile = require('../../casc/blp');
const WDTLoader = require('../loaders/WDTLoader');
const ADTLoader = require('../loaders/ADTLoader');
const OBJWriter = require('../writers/OBJWriter');
const MTLWriter = require('../writers/MTLWriter');
const WDCReader = require('../../db/WDCReader');
const DB_GroundEffectTexture = require('../../db/schema/GroundEffectTexture');
const DB_GroundEffectDoodad = require('../../db/schema/GroundEffectDoodad');

const ExportHelper = require('../../casc/export-helper');
const M2Exporter = require('./M2Exporter');
const WMOExporter = require('./WMOExporter');
const CSVWriter = require('../writers/CSVWriter');
const { SSL_OP_SSLEAY_080_CLIENT_DH_BUG } = require('constants');
const LoaderGenerics = require('../loaders/LoaderGenerics');
const { Z_ASCII } = require('zlib');

const MAP_SIZE = constants.GAME.MAP_SIZE;
const TILE_SIZE = constants.GAME.TILE_SIZE;
const CHUNK_SIZE = TILE_SIZE / 16;
const UNIT_SIZE = CHUNK_SIZE / 8;
const UNIT_SIZE_HALF = UNIT_SIZE / 2;

const wdtCache = new Map();

const FRAG_SHADER_SRC = path.join(constants.SHADER_PATH, 'adt.fragment.shader');
const VERT_SHADER_SRC = path.join(constants.SHADER_PATH, 'adt.vertex.shader');

let isFoliageAvailable = false;
let hasLoadedFoliage = false;
let dbTextures;
let dbDoodads;

let glShaderProg;
let glCanvas;
let gl;

/**
 * Load a texture from CASC and bind it to the GL context.
 * @param {number} fileDataID 
 */
const loadTexture = async (fileDataID) => {
	const texture = gl.createTexture();
	const blp = new BLPFile(await core.view.casc.getFile(fileDataID));

	gl.bindTexture(gl.TEXTURE_2D, texture);

	// For unknown reasons, we have to store blpData as a variable. Inlining it into the
	// parameter list causes issues, despite it being synchronous.
	const blpData = blp.toUInt8Array(0);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, blp.scaledWidth, blp.scaledHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, blpData);
	gl.generateMipmap(gl.TEXTURE_2D);

	return texture;
};

/**
 * Load and cache GroundEffectDoodad and GroundEffectTexture data tables.
 */
const loadFoliageTables = async () => {
	if (!hasLoadedFoliage) {
		try {
			dbDoodads = new WDCReader('DBFilesClient/GroundEffectDoodad.db2', DB_GroundEffectDoodad);
			dbTextures = new WDCReader('DBFilesClient/GroundEffectTexture.db2', DB_GroundEffectTexture);

			await dbDoodads.parse();
			await dbTextures.parse();

			hasLoadedFoliage = true;
			isFoliageAvailable = true;
		} catch (e) {
			isFoliageAvailable = false;
			log.write('Unable to load foliage tables, foliage exporting will be unavailable for all tiles.');
		}

		hasLoadedFoliage = true;
	}
};

/**
 * Bind an alpha layer to the GL context.
 * @param {Array} layer 
 */
const bindAlphaLayer = (layer) => {
	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);

	const data = new Uint8Array(layer.length * 4);
	for (let i = 0, j = 0, n = layer.length; i < n; i++, j += 4)
		data[j + 0] = data[j + 1] = data[j + 2] = data[j + 3] = layer[i];

	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
	gl.generateMipmap(gl.TEXTURE_2D);

	return texture;
};

/**
 * Unbind all textures from the GL context.
 */
const unbindAllTextures = () => {
	// Unbind textures.
	for (let i = 0, n = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS); i < n; i++) {
		gl.activeTexture(gl.TEXTURE0 + i);
		gl.bindTexture(gl.TEXTURE_2D, null);
	}
};

/**
 * Clear the canvas, resetting it to black.
 */
const clearCanvas = () => {
	gl.viewport(0, 0, glCanvas.width, glCanvas.height);
	gl.clearColor(0, 0, 0, 1);
	gl.clear(gl.COLOR_BUFFER_BIT);
};

/**
 * Save the current canvas state to a file.
 * @param {string} out
 */
const saveCanvas = async (out) => {
	// This is a quick and easy fix to rotate tiles to their correct orientation.
	const rotate = document.createElement('canvas');
	rotate.width = glCanvas.width;
	rotate.height = glCanvas.height;

	const ctx = rotate.getContext('2d');
	ctx.translate(rotate.width / 2, rotate.height / 2);
	ctx.rotate(Math.PI / 180 * 180);
	ctx.drawImage(glCanvas, -(rotate.width / 2), -(rotate.height / 2));

	const buf = await BufferWrapper.fromCanvas(rotate, 'image/png');
	await buf.writeToFile(out);
};

/**
 * Compile the vertex and fragment shaders used for baking.
 * Will be attached to the current GL context.
 */
const compileShaders = async () => {
	glShaderProg = gl.createProgram();

	// Compile fragment shader.
	const fragShader = gl.createShader(gl.FRAGMENT_SHADER);
	gl.shaderSource(fragShader, await fsp.readFile(FRAG_SHADER_SRC, 'utf8'));
	gl.compileShader(fragShader);

	if (!gl.getShaderParameter(fragShader, gl.COMPILE_STATUS)) {
		log.write('Fragment shader failed to compile: %s', gl.getShaderInfoLog(fragShader));
		throw new Error('Failed to compile fragment shader');
	}

	// Compile vertex shader.
	const vertShader = gl.createShader(gl.VERTEX_SHADER);
	gl.shaderSource(vertShader, await fsp.readFile(VERT_SHADER_SRC, 'utf8'));
	gl.compileShader(vertShader);

	if (!gl.getShaderParameter(vertShader, gl.COMPILE_STATUS)) {
		log.write('Vertex shader failed to compile: %s', gl.getShaderInfoLog(vertShader));
		throw new Error('Failed to compile vertex shader');
	}

	// Attach shaders.
	gl.attachShader(glShaderProg, fragShader);
	gl.attachShader(glShaderProg, vertShader);

	// Link program.
	gl.linkProgram(glShaderProg);	
	if (!gl.getProgramParameter(glShaderProg, gl.LINK_STATUS)) {
		log.write('Unable to link shader program: %s', gl.getProgramInfoLog(glShaderProg));
		throw new Error('Failed to link shader program');
	}

	gl.useProgram(glShaderProg);
};

class ADTExporter4x4 {
	/**
	 * Construct a new ADTLoader4x4 instance.
	 * @param {number} mapID 
	 * @param {string} mapDir 
	 * @param {number} tileIndex 
	 * @param {number} loopIndex
	 * @param {Array}  materialArrayFull
	 */
	constructor(mapID, mapDir, tileIndex, loopIndex, materialArrayFull) {
		this.mapID = mapID;
		this.mapDir = mapDir;
		this.tileX = tileIndex % MAP_SIZE;
		this.tileY = Math.floor(tileIndex / MAP_SIZE);
		this.tileID = this.tileY + '_' + this.tileX;
		this.tileIndex = tileIndex;
		this.loopIndex = loopIndex;
		this.materialArrayFull = materialArrayFull;
	}

	/**
	 * Export the ADT tile.
	 * @param {string} dir Directory to export the tile into.
	 * @param {number} textureRes
	 */
	async export(dir, quality) {
		log.write("Loop " + this.loopIndex + ", exporting adtX: " + this.tileX + ", adtY: " + this.tileY);
		var returnArray = new Array(8).fill(0);
		returnArray[0] = this.mapDir; // Zone name
		returnArray[1] = this.tileY; // ADT Y
		returnArray[2] = this.tileX; // ADT X
		returnArray[6] = []; // Heightmap: 2x2 Array 1025x1025
		returnArray[7] = []; // PixelData Array 

		const casc = core.view.casc;
		const config = core.view.config;
		const prefix = util.format('world/maps/%s/%s', this.mapDir, this.mapDir);

		// Load the WDT. We cache this to speed up exporting large amounts of tiles from the same map. Make sure ADTLoader.clearCache() is called after exporting.
		let wdt = wdtCache.get(this.mapDir);
		if (!wdt) {
			wdt = new WDTLoader(await casc.getFileByName(prefix + '.wdt'));
			await wdt.load();
			wdtCache.set(this.mapDir, wdt);
		}
		
		const tilePrefix = prefix + '_' + this.tileID;
		const maid = wdt.entries[this.tileIndex];
		const rootFileDataID = maid.rootADT > 0 ? maid.rootADT : listfile.getByFilename(tilePrefix + '.adt');
		const tex0FileDataID = maid.tex0ADT > 0 ? maid.tex0ADT : listfile.getByFilename(tilePrefix + '_obj0.adt');
		const obj0FileDataID = maid.obj0ADT > 0 ? maid.obj0ADT : listfile.getByFilename(tilePrefix + '_tex0.adt');

		// Ensure we actually have the fileDataIDs for the files we need.
		if (rootFileDataID === 0 || tex0FileDataID === 0 || obj0FileDataID === 0)
			throw new Error('Missing fileDataID for ADT files: ' + [rootFileDataID, tex0FileDataID, obj0FileDataID].join(', '));

		const rootAdt = new ADTLoader(await casc.getFile(rootFileDataID));
		rootAdt.loadRoot();
		const texAdt = new ADTLoader(await casc.getFile(tex0FileDataID));
		texAdt.loadTex(wdt);
		const objAdt = new ADTLoader(await casc.getFile(obj0FileDataID));
		objAdt.loadObj();

		const vertices = new Array(16 * 16 * 145 * 3);
		const normals = new Array(16 * 16 * 145 * 3);
		const uvs = new Array(16 * 16 * 145 * 2);
		const uvsBake = new Array(16 * 16 * 145 * 2);
		const vertexColors = new Array(16 * 16 * 145 * 4);
		const chunkMeshes = new Array(256);
		const obj = new OBJWriter(path.join(dir, 'adt_' + this.tileID + '.obj'));
		const mtl = new MTLWriter(path.join(dir, 'adt_' + this.tileID + '.mtl'));
		const firstChunk = rootAdt.chunks[0];
		const firstChunkX = firstChunk.position[0];
		const firstChunkY = firstChunk.position[1];		
		const splitTextures = quality >= 8192;

		// Writing a 257x257 image in 16x16 chunks of 16x16 and 17x17 pixels
		var bytesPerPixel      = 4;     // Each pixel has a R,G,B,A byte
		var bytesPerColumn     = 18496; // A 'column' is 257 pixels vertical (chunk): bytesPerRow * b
		var bytesPerRow        = 1028;  // A 'row' is 257 pixels horizontal (chunk): a * 4				
		var bytesPerSubColumn  = 1024;  // A 'subcolumn' is 16 pixels vertical (subchunk): bytesPerSubRow * b 
		var bytesPerLSubColumn = 1156;  // (final subcolumn has 17 pixels)		
		var bytesPerSubRow     = 64;    // A 'subrow' is 16 pixels horizontal  (subchunk): b * 4
		var byterPerLongSubRow = 68;    // (final subrow has 17 pixels)		
		
		// 16x16
		var pixelPerRow        = 256;
		var pixelPerColumn     = 4096; //pixelPerSubColumn * numOfColums 
		var pixelPerSubRow     = 16;
		//var pixelPerSubColumn  = 256; // 16x16

		// 16x17
		pixelPerRow       = 256;   // a * 16
		pixelPerColumn    = 4352;  // pixelPerSubColumn * 16
		pixelPerSubRow    = 16;    // a
		//pixelPerSubColumn = 272; // b*a

		// 17x16
		pixelPerRow       = 272;  // a * 16
		pixelPerColumn    = 4352; // pixelPerSubColumn * 16
		pixelPerSubRow    = 17;   // a
		//pixelPerSubColumn = 272;  // b*a

		// 17x17
		pixelPerRow       = 272;  // a * 16
		pixelPerColumn    = 4624; // pixelPerSubColumn * 16
		pixelPerSubRow    = 17;   // a
		//pixelPerSubColumn = 289;  // b*a
		
		var vertexHeightList = [66049]; // Some are overlapping
		var hCount = 0;
		let ofs = 0;
		let chunkID = 0;
		for (let x = 0, midX = 0; x < 16; x++) { // chunk
			for (let y = 0; y < 16; y++) { // chunk
				const indices = [];
				const chunkIndex = (x * 16) + y;
				const chunk = rootAdt.chunks[chunkIndex];
				const chunkX = chunk.position[0];
				const chunkY = chunk.position[1];
				const chunkZ = chunk.position[2];

				for (let row = 0, idx = 0; row < 17; row++) { // subchunk
					const isShort = !!(row % 2);
					const colCount = isShort ? 8 : 9;

					for (let col = 0; col < colCount; col++) {
						let vx = chunkY - (col * UNIT_SIZE);
						let vy = chunk.vertices[idx] + chunkZ;
						let vz = chunkX - (row * UNIT_SIZE_HALF);

						if (isShort) { vx -= UNIT_SIZE_HALF; }						
						const vIndex = midX * 3;
						vertices[vIndex + 0] = vx;
						vertices[vIndex + 1] = vy;
						vertices[vIndex + 2] = vz;

						// Saving height data
						let vY = chunk.vertices[idx] + chunkZ;
						let vyMinus1 = chunk.vertices[idx-1] + chunkZ;
						let vyMinus8 = chunk.vertices[idx-8] + chunkZ;
						let vyMinus9 = chunk.vertices[idx-9] + chunkZ;
						let vyPlus8 = chunk.vertices[idx+8] + chunkZ;
						let vyPlus9 = chunk.vertices[idx+9] + chunkZ;
						
						if (x < 15){
							if (!isShort && y < 15 && row < 16){ // Long Column; Don't draw bottom row
								if (col == 0){
									vertexHeightList[hCount] = vY;
									hCount++;
								}else if (col < 8){
									vertexHeightList[hCount] = (vyMinus1 + vy) / 2; // New Vertex in middle
									hCount++;
									vertexHeightList[hCount] = vY;
									hCount++;
								}else if (col == 8){ // Bottom Left Corner
									vertexHeightList[hCount] = (vyMinus1 + vY) / 2; // New Vertex in middle
									hCount++;
								}
							}else if (!isShort && y == 15 && row < 16){ // Long Column; Include bottom row
								
									if (col == 0){
										vertexHeightList[hCount] = vY;
										hCount++;
									}else{
										vertexHeightList[hCount] = (vyMinus1 + vY) / 2; // New Vertex in middle
										hCount++;
										vertexHeightList[hCount] = vY; // Include bottom row of pixels
										hCount++;
									}
							}else if (isShort && y < 15 && row < 16){ // Short Column; Don't draw bottom row
								vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; // New Vertex in middle
								hCount++;
								vertexHeightList[hCount] = vY;
								hCount++;
							}else if (isShort && y == 15 && row < 16){ // Short Column; Include bottom row								
								if (col < 7){
									vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; // New Vertex in middle 
									hCount++;
									vertexHeightList[hCount] = vY; 
									hCount++;
								}else if (col == 7){
									vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; // New Vertex in middle 
									hCount++;
									vertexHeightList[hCount] = vY; 
									hCount++;
									vertexHeightList[hCount] = (vyMinus8 + vyPlus9) / 2; 
									hCount++;
								}
							}
						}
						else if (x == 15){ // Include Right Edge							
							if (!isShort && y < 15){ // Long Column; Don't draw bottom row
								if (col == 0){									
									vertexHeightList[hCount] = vy;
									hCount++;
								}else if (col < 8){									
									vertexHeightList[hCount] = (vyMinus1 + vy) / 2; // New Vertex in middle
									hCount++;
									vertexHeightList[hCount] = vy;
									hCount++;
								}else if (col == 8){ // Bottom Left Corner
									vertexHeightList[hCount] = (vyMinus1 + vy) / 2; // New Vertex in middle
									hCount++;									
								}															
							}else if (!isShort && y == 15){ // Long Column; Include bottom row
								if (col == 0){									
									vertexHeightList[hCount] = vy; 
									hCount++;
								}else if (col < 8){									
									vertexHeightList[hCount] = (vyMinus1 + vy) / 2; // New Vertex in middle
									hCount++;
									vertexHeightList[hCount] = vy;
									hCount++;
								}else if (col == 8){ // Bottom Pixel
									vertexHeightList[hCount] = (vyMinus1 + vy) / 2; // New Vertex in middle
									hCount++;
									vertexHeightList[hCount] = vy; // Include bottom row of pixels
									hCount++;
								}
							}else if (isShort && y < 15){ // Short Column; Don't draw bottom row
								vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; // New Vertex in middle
								hCount++;
								vertexHeightList[hCount] = vy;
								hCount++;
							}else if (isShort && y == 15){ // Short Column; Include bottom row
								if (col < 7){
									vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; // New Vertex in middle
									hCount++;
									vertexHeightList[hCount] = vy;
									hCount++;
								}else if (col == 7){
									vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; // New Vertex in middle
									hCount++;
									vertexHeightList[hCount] = vy;
									hCount++;
									vertexHeightList[hCount] = (vyMinus8 + vyPlus9) / 2; // Include bottom vertex
									hCount++;
								}							
							}
						}						
						const normal = chunk.normals[idx];
						normals[vIndex + 0] = normal[0] / 127;
						normals[vIndex + 1] = normal[1] / 127;
						normals[vIndex + 2] = normal[2] / 127;
						const cIndex = midX * 4;
						if (chunk.vertexShading) { // Store vertex shading in BGRA format.
							const color = chunk.vertexShading[idx];
							vertexColors[cIndex + 0] = color.b / 255;
							vertexColors[cIndex + 1] = color.g / 255;
							vertexColors[cIndex + 2] = color.r / 255;
							vertexColors[cIndex + 3] = color.a / 255;
						} else { // No vertex shading, default to this.
							vertexColors[cIndex + 0] = 0.5;
							vertexColors[cIndex + 1] = 0.5;
							vertexColors[cIndex + 2] = 0.5;
							vertexColors[cIndex + 3] = 1;
						}
						const uvIdx = isShort ? col + 0.5 : col;
						const uvIndex = midX * 2;
						uvsBake[uvIndex + 0] = -(vx - firstChunkX) / TILE_SIZE;
						uvsBake[uvIndex + 1] = (vz - firstChunkY) / TILE_SIZE;

						if (quality === 0) {
							uvs[uvIndex + 0] = uvIdx / 8;
							uvs[uvIndex + 1] = (row * 0.5) / 8;
						} else if (splitTextures || quality === -1) {
							uvs[uvIndex + 0] = uvIdx / 8;
							uvs[uvIndex + 1] = 1 - (row / 16);
						} else {
							uvs[uvIndex + 0] = uvsBake[uvIndex + 0];
							uvs[uvIndex + 1] = uvsBake[uvIndex + 1];
						}
						idx++;
						midX++;
					}
				}
				const holesHighRes = chunk.holesHighRes;
				for (let j = 9, xx = 0, yy = 0; j < 145; j++, xx++) {
					if (xx >= 8) {
						xx = 0;
						yy++;
					}

					let isHole = true;
					if (!(chunk.flags & 0x10000)) {
						const current = Math.trunc(Math.pow(2, Math.floor(xx / 2) + Math.floor(yy / 2) * 4));

						if (!(chunk.holesLowRes & current))
							isHole = false;
					} else {
						if (!((holesHighRes[yy] >> xx) & 1))
							isHole = false;
					}

					if (!isHole) {
						const indOfs = ofs + j;
						indices.push(indOfs, indOfs - 9, indOfs + 8);
						indices.push(indOfs, indOfs - 8, indOfs - 9);
						indices.push(indOfs, indOfs + 9, indOfs - 8);
						indices.push(indOfs, indOfs + 8, indOfs + 9);
					}

					if (!((j + 1) % (9 + 8)))
						j += 9;
				}
				ofs = midX;
				if (splitTextures || quality === -1) {
					const objName = this.tileID + '_' + chunkID;
					const matName = 'tex_' + objName;
					mtl.addMaterial(matName, matName + '.png');
					obj.addMesh(objName, indices, matName);
				} else {
					obj.addMesh(chunkID, indices, 'tex_' + this.tileID);
				}
				chunkMeshes[chunkIndex] = indices;
				chunkID++;				
			}
		}
		// Determine min/max terrain height values
		var maxHeight = (Math.max(...vertexHeightList));
		var minHeight = (Math.min(...vertexHeightList));		
		
		//var numOfPixelRows = 15; // X
		//var numOfPixelCols = 15; // Y
		var heightArray2d = [...Array(257)].map(e => Array(257));
		//var numOfHeightValues = 0;
		/*if (this.loopIndex == 15){ //15
			//numOfHeightValues = 66049;
			heightArray2d = [...Array(257)].map(e => Array(257));
			//numOfPixelRows = 16;
			//numOfPixelCols = 16;
		}else if (this.loopIndex % 4 == 3){ // 3, 7, 11
			//numOfHeightValues = 65792;
			heightArray2d = [...Array(256)].map(e => Array(257));
			//numOfPixelRows = 15;
			//numOfPixelCols = 16;
		}else if (this.loopIndex >= 12){ // 12, 13, 14
			//numOfHeightValues = 65792;
			heightArray2d = [...Array(257)].map(e => Array(256));
			//numOfPixelRows = 16;
			//numOfPixelCols = 15;
		}else{ // 0, 1, 2,  4, 5, 6,  8, 9, 10
			//numOfHeightValues = 65536;
			heightArray2d = [...Array(256)].map(e => Array(256));
			//numOfPixelRows = 15;
			//numOfPixelCols = 15;
		}*/

		// Check for values which are not numbers		
		for (var i = 0; i < 66049; i++){
			if (isNaN(vertexHeightList[i])){
				log.write(i + " is NOT a valid number: NaN!");
				vertexHeightList[i] = maxHeight;
			}
		}
		// Save Height Data
		var index = 0;		
		var heightArraySubchunk = [...Array(16)].map(e => Array(16));
		var pixelPerSubChunk = 256;
		var countpixels = 0;
		
		for (let y = 0; y < 16; y++) { // needs to be 16, subchchunk
			for (let x = 0; x < 16; x++) { //needs to be 16, subchchunk
				var xSize = 16;
				var ySize = 16;
				if (x == 15 && y == 15){
					xSize = 17;
					ySize = 17;
					pixelPerSubChunk = 289;
					heightArraySubchunk = [...Array(17)].map(e => Array(17).fill(0));				
				}else if (y == 15 && x < 15){
					ySize = 17;
					pixelPerSubChunk = 272;
					heightArraySubchunk = [...Array(16)].map(e => Array(17).fill(0));
				}else if (x == 15 && y < 15){
					xSize = 17;
					pixelPerSubChunk = 272;
					heightArraySubchunk = [...Array(17)].map(e => Array(16).fill(0));				
				}else{
					pixelPerSubChunk = 256;
					heightArraySubchunk = [...Array(16)].map(e => Array(16).fill(0));
				}
				
				for (let row = 0; row < ySize; row++) {
					for (let col = 0; col < xSize; col ++){						
						var pixIndex = ((row * xSize) + (col)); 
						var index = countpixels + pixIndex;						
						var xPos = Math.floor(pixIndex / xSize);
						var yPos = pixIndex - (xPos * xSize);
						if (vertexHeightList[index] === undefined){ log.write("vertexHeightList[" + index + "undefined."); }
						if (heightArraySubchunk[yPos][xPos] === undefined){	log.write("heightArraySubchunk[yPos][xPos] undefined! yPos: " + xPos + ", xPos: " + yPos); }
						heightArraySubchunk[yPos][xPos] = vertexHeightList[index];
					}
				}
				
				if (heightArray2d === undefined){ log.write("heightArray2d undefined")};
				if (heightArraySubchunk === undefined){ log.write("heightArraySubchunk undefined")};
				for (var a=0; a < heightArraySubchunk.length; a++){
					var xRow = heightArraySubchunk[a];
					for (var b=0; b < xRow.length; b++){
						if (heightArraySubchunk[a][b] === undefined) { log.write("heightArraySubchunk[" + a + "][" + b + "] is undefined!");}
						heightArray2d[y*16 + b][x*16 + a] = heightArraySubchunk[a][b];
					}
				}
				countpixels += pixelPerSubChunk;
			}
			
			if (this.loopIndex == 15){ //15
			}else if (this.loopIndex % 4 == 3){ // 3, 7, 11
			}else if (this.loopIndex >= 12){ // 12, 13, 14
			}else{ // 0, 1, 2,  4, 5, 6,  8, 9, 10
				//countpixels += 272;
			}
			//log.write("countpixels: " + countpixels);
		}
		// I don't know why but reverse the array
		/*for (var a=0; a < heightArray2d.length; a++){
			heightArray2d[a].reverse();
		}*/
		
		returnArray[6].push(heightArray2d);

		var jsonPath = path.join(dir, 'adt_' + this.tileID + '_HeightData.json');
		returnArray[4] = jsonPath;
		try { fs.writeFileSync(jsonPath, JSON.stringify(heightArray2d)); //heightmapParsedJSON
			} catch (err) { log.write(err); }
		if (!splitTextures && quality !== -1) { mtl.addMaterial('tex_' + this.tileID, 'tex_' + this.tileID + '.png'); }

		obj.setVertArray(vertices);
		obj.setNormalArray(normals);
		obj.setUVArray(uvs);

		if (!mtl.isEmpty) { obj.setMaterialLibrary(path.basename(mtl.out)); }
		//await obj.write(config.overwriteFiles); // WE ARE NOT USING OBJ OR MTL files anymore.
		//await mtl.write(config.overwriteFiles); // OBJ is replaced with with heightData.json. MTL is replaced with matData.json.

		if (quality !== 0) {
			if (quality === -2){
				// Export splat maps.
				const materialIDs = texAdt.diffuseTextureFileDataIDs;
				const texParams = texAdt.texParams;
				const prefix = this.tileID;

				// Export the raw diffuse textures to disk.
				const materials = new Array(materialIDs.length);
				for (let i = 0, n = materials.length; i < n; i++) {
					const diffuseFileDataID = materialIDs[i];
					const blp = new BLPFile(await core.view.casc.getFile(diffuseFileDataID));
					var newPath = path.join(dir + '../../../textures/terrain/');
					newPath = path.join(newPath, diffuseFileDataID + '.png');
					await blp.saveToFile(newPath, 'image/png', false); //path.join(dir, diffuseFileDataID + '.png');
					const mat = materials[i] = { scale: 1, id: diffuseFileDataID };
					if (texParams && texParams[i]) {
						const params = texParams[i];
						mat.scale = Math.pow(2, (params.flags & 0xF0) >> 4);
					}
				}
				
				// this.materialArrayFull   // USE THIS FOR SPLATMAP CREATION
				
				var imageCount = Math.ceil(this.materialArrayFull.length/4); // was materialIDs.length
				//log.write("imageCount: " + imageCount);
				var pixelData = new Array(imageCount);
				for (var p = 0; p < pixelData.length; p++){
					pixelData[p] = new Uint8ClampedArray(1024 * 1024 * 4);	
					//log.write("PixelData Array: " + p);
				}
				// Writing a 1024x1024 image in 64x64 chunks
				var bytesPerPixel     = 4;      // Each pixel has a R,G,B,A byte
				var bytesPerColumn    = 262144; // A 'column' is 1024 pixels vertical (chunk) bytesPerRow * b
				var bytesPerRow       = 4096;   // A 'row' is 1024 pixels horizontal (chunk) a * 4
				var bytesPerSubColumn = 16384;  // A 'subcolumn' is 64 pixels vertical (subchunk) bytesPerSubRow * b
				var bytesPerSubRow    = 256;    // A 'subrow' is 64 pixels horizontal (subchunk) b * 4
								
				const lines = [];
				//var tga = new TGA(fs.readFileSync('./src/images/TGATemplate.tga'));
				var materialJSON = '{ "chunkData" : {'; // New JSON file to save material data
				
				// Populate the JSON data for all 256 subchunks
				for (let x = 0; x < 16; x++) {	
					for (let y = 0; y < 16; y++) {
						const chunkIndex = (y * 16) + x;
						const texChunk = texAdt.texChunks[chunkIndex];
						// New parent object named with index "0", "1", "2", etc
						materialJSON += '"' + chunkIndex + '": [';
						
						if (texChunk.layers.length == 0) { // COULD BE ZERO!!!
							materialJSON += '{"id":"' + 0 + '","scale":"' + 0 + '"},';
						}

						for (let i = 0, n = texChunk.layers.length; i < n; i++) { 
							const mat = materials[texChunk.layers[i].textureId];
							materialJSON += '{"id":"' + mat.id + '","scale":"' + mat.scale + '"},';
							lines.push([chunkIndex, i, mat.id, mat.scale].join(','));							
						}
						materialJSON = materialJSON.substring(0, materialJSON.length - 1); // remove tailing comma
						materialJSON += '],'; // Close the subchunk array
					}
				}
				materialJSON = materialJSON.substring(0, materialJSON.length - 1); // remove tailing comma
				var fullJSON = materialJSON + '}, "splatmapData" : {'; // create JSON data to include splatmap data
				materialJSON += '}}'; // Close the JSON data
				var matJSON = JSON.parse(materialJSON);
				
				if (materialIDs.length == 0){
					fullJSON += '"id0":"null",';
				}else{
					for (let q=0; q < materialIDs.length; q++){
						fullJSON += '"id' + q + '":"' + materialIDs[q] + '",';						
					}
				}
				//returnArray[7] = materialList; Material lists are genereated before ADTExport4x4 is run
				fullJSON = fullJSON.substring(0, fullJSON.length - 1); // remove tailing comma
				fullJSON += '}}'; // Close the JSON data
				var fullParsedJSON = JSON.parse(fullJSON);
				
				// Now before we draw each sub-chunk to TGA, we need to check it's texture list in json.
				// Based on what order the textures are for that sub-chunk, we may need to draw RGBA in a different order than 0,1,2,3
				// Loop Y first so we go left to right, top to bottom. Loop 16x16 subchunks to get the full chunk
				for (let x = 0; x < 16; x++) {
					for (let y = 0; y < 16; y++) {
						const chunkIndex = (y * 16) + x;
						const texChunk = texAdt.texChunks[chunkIndex];
						const alphaLayers = texChunk.alphaLayers || [];
						const textureLayers = texChunk.layers;

						// If there is no texture data just skip it
						if (textureLayers.length > 0) {
							// If there is texture data, we need a base layer of red to flood the subchunk
							for (let j = y * bytesPerColumn; j < (y * bytesPerColumn) + bytesPerColumn; j += bytesPerRow) { // 1024 pixels wide, 64 pixels high = 65536 * 4 bytes = 262144 (looping y axis)
								// Now we need to loop the x axis, 64 pixels long
								for (let i = x * bytesPerSubRow; i < (x * bytesPerSubRow) + bytesPerSubRow; i += bytesPerPixel) { // 64 pixels, 4 bytes each = 256
									var yloop = ((j / bytesPerRow) - (y * bytesPerColumn) / bytesPerRow);
									var xloop = ((i / 4) - ((x * bytesPerSubRow) / 4));
									var alphaIndex = (yloop * 64) + xloop;									
									// Must flood base color, may be R, G, B, A
									// In the case of Azeroth_29_47 subchunk 2, base layer is blue
									if (pixelData[0][j + i + 0] === undefined) { log.write("pixeldata[0]" + [j + i + 0] + " is undefined!"); }									
									//pixelData[0][j + i + 0] = 255; // Red: (186865) NOT FLOODING RED ANYMORE

									var numberTextureLayers = matJSON.chunkData[chunkIndex].length;									
									for (var k = 0; k < numberTextureLayers; k++){ // Looping texture layers, could be 0-100
										// k = 1, random materialID. This could be any RGBA, RGBA color!										
										if (matJSON.chunkData[chunkIndex][k] === undefined){ log.write("Error: matJSON.chunkData[chunkIndex][k] is undefined"); }
										var currentIndex = -1;
										var currentID =  matJSON.chunkData[chunkIndex][k].id;
										for (var l = 0; l < this.materialArrayFull.length; l++) {
											if (this.materialArrayFull[l] == currentID) {
												currentIndex = l;
											}
										}										
										if (currentIndex == -1){ log.write("ERROR: Index is still -1 after loop:" + currentID);	}
										var texIndex = currentIndex;										
										// alphaLayers is an array equal to length of textures and in the same order as materialIDs
										// each array item is an Array(64 * 64)
										// alphaLayers[0] is filled with red (255)

										// Red   / 0 has everything subtracted from it
										// Green / 1 has Blue & Alpha subtracted from it
										// Blue  / 2 has Alpha subtracted from it

										// Calculate image index, 1 TGA image for each 4 textures. index 0 includes base texture on channel 0										
										var imageIndex = Math.floor(texIndex/4);

										// 0-3 RGBA.
										var channelIndex = texIndex % 4;										
										// 				  array [whichTGA] Pixel|channel
										if (pixelData[imageIndex] === undefined){ log.write("pixelData[" + imageIndex +"] is undefined"); }
										if (pixelData[imageIndex][j + i + channelIndex] === undefined){ log.write("pixeldata[" + imageIndex + "]" + ", channelIndex:" + channelIndex + " is undefined!"); }
										
										// Write the actual pixel data
										if (k == 0) { // BASE LAYER 
											pixelData[imageIndex][j + i + channelIndex] = 255; // Flood Base Layer
										}else{
											if (alphaLayers[k] === undefined){
												log.write("alphaLayers[k] is undefined: " + texIndex + ". Alphalayers length: " + alphaLayers.length + ", Chunk: " + chunkIndex);
											}
											if (alphaLayers[k][alphaIndex] === undefined){
												log.write("alphaLayers[" + k + "] alphaIndex[" + alphaIndex + "] is undefined!");
											}

											pixelData[imageIndex][j + i + channelIndex] = alphaLayers[k][alphaIndex];
											
											for (var m = 0; m < imageCount; m++){ // All images
												//log.write("pixelData[" + m + "] looping");
												if (pixelData[m] === undefined) {log.write("ERROR: pixeldata[" + m + "] is undefined!");}
												if (m != imageIndex){
													if (chunkIndex == 75 && xloop == 0 && yloop == 0) { log.write("subtract full image: " + m)}
													if (pixelData[m][j + i + 0] === undefined) { log.write("pixelData[" + m +"] is undefined!");}
													pixelData[m][j + i + 0] -= alphaLayers[k][alphaIndex];
													pixelData[m][j + i + 1] -= alphaLayers[k][alphaIndex];
													pixelData[m][j + i + 2] -= alphaLayers[k][alphaIndex];
													pixelData[m][j + i + 3] -= alphaLayers[k][alphaIndex];
												}
											}

											for (var n = 0; n < 4; n++){ // Loop 4 times
												if (n != channelIndex){
													pixelData[imageIndex][j + i + n] -= alphaLayers[k][alphaIndex];
												}
											}
										}
									}
								}
							}
						}
					}
				}
				log.write("Finished Splatmap Loop");
				jsonPath = path.join(dir, 'adt_' + this.tileID + '_MaterialData.json');
				
				try { fs.writeFileSync(jsonPath, JSON.stringify(fullParsedJSON));
					} catch (err) { console.error(err); }
				returnArray[5] = jsonPath;
				returnArray[7] = pixelData;

				// Moved tga generation to Tab-map.js				

				//const metaOut = path.join(dir, 'tex_' + prefix + '.csv');
				//await fsp.writeFile(metaOut, lines.join('\n'), 'utf8'); // Do not need tex_31_32.csv anymore, all material data is now saved in matData.json

			} else if (quality === -1) {
				// Export alpha maps.
				// Create a 2D canvas for drawing the alpha maps.
				const canvas = document.createElement('canvas');
				const ctx = canvas.getContext('2d');

				const materialIDs = texAdt.diffuseTextureFileDataIDs;
				const texParams = texAdt.texParams;

				// Export the raw diffuse textures to disk.
				const materials = new Array(materialIDs.length);
				for (let i = 0, n = materials.length; i < n; i++) {
					const diffuseFileDataID = materialIDs[i];
					const blp = new BLPFile(await core.view.casc.getFile(diffuseFileDataID));
					await blp.saveToFile(path.join(dir, diffuseFileDataID + '.png'), 'image/png', false);

					const mat = materials[i] = { scale: 1, id: diffuseFileDataID };

					if (texParams && texParams[i]) {
						const params = texParams[i];
						mat.scale = Math.pow(2, (params.flags & 0xF0) >> 4);
					}
				}

				// Alpha maps are 64x64, we're not up-scaling here.
				canvas.width = 64;
				canvas.height = 64;

				let chunkID = 0;
				for (let x = 0; x < 16; x++) {
					for (let y = 0; y < 16; y++) {
						const chunkIndex = (x * 16) + y;
						const texChunk = texAdt.texChunks[chunkIndex];

						const alphaLayers = texChunk.alphaLayers || [];
						const imageData = ctx.createImageData(64, 64);

						// Write each layer as RGB.
						for (let i = 1; i < alphaLayers.length; i++) {
							const layer = alphaLayers[i];

							for (let j = 0; j < layer.length; j++)
								imageData.data[(j * 4) + (i - 1)] = layer[j];
						}

						// Set all the alpha values to max.
						for (let i = 0; i < 64 * 64; i++)
							imageData.data[(i * 4) + 3] = 255;

						ctx.putImageData(imageData, 0, 0);

						const prefix = this.tileID + '_' + (chunkID++);
						const tilePath = path.join(dir, 'tex_' + prefix + '.png');

						const buf = await BufferWrapper.fromCanvas(canvas, 'image/png');
						await buf.writeToFile(tilePath);

						const texLayers = texChunk.layers;
						const lines = [];
						for (let i = 0, n = texLayers.length; i < n; i++) {
							const mat = materials[texLayers[i].textureId];
							lines.push([i, mat.id, mat.scale].join(','));
						}

						const metaOut = path.join(dir, 'tex_' + prefix + '.csv');
						await fsp.writeFile(metaOut, lines.join('\n'), 'utf8');
					}
				}
			} else if (quality <= 512) {
				// Use minimaps for cheap textures.
				const tilePath = util.format('world/minimaps/%s/map%d_%d.blp', this.mapDir, this.tileY, this.tileX);
				const tileOutPath = path.join(dir, 'tex_' + this.tileID + '.png');

				if (config.overwriteFiles || !await generics.fileExists(tileOutPath)) {
					const data = await casc.getFileByName(tilePath, false, true);
					const blp = new BLPFile(data);

					// Draw the BLP onto a raw-sized canvas.
					const canvas = blp.toCanvas(false);

					// Scale the image down by copying the raw canvas onto a
					// scaled canvas, and then returning the scaled image data.
					const scale = quality / blp.scaledWidth;
					const scaled = document.createElement('canvas');
					scaled.width = quality;
					scaled.height = quality;

					const ctx = scaled.getContext('2d');
					ctx.scale(scale, scale);
					ctx.drawImage(canvas, 0, 0);

					const buf = await BufferWrapper.fromCanvas(scaled, 'image/png');
					await buf.writeToFile(tileOutPath);
				} else {
					log.write('Skipping ADT bake of %s (file exists, overwrite disabled)', tileOutPath);
				}
			} else {
				const tileOutPath = path.join(dir, 'tex_' + this.tileID + '.png');
				if (splitTextures || config.overwriteFiles || !await generics.fileExists(tileOutPath)) {
					// Create new GL context and compile shaders.
					if (!gl) {
						glCanvas = document.createElement('canvas');
						gl = glCanvas.getContext('webgl');

						await compileShaders();
					}

					// Materials
					const materialIDs = texAdt.diffuseTextureFileDataIDs;
					const heightIDs = texAdt.heightTextureFileDataIDs;
					const texParams = texAdt.texParams;

					const materials = new Array(materialIDs.length);
					for (let i = 0, n = materials.length; i < n; i++) {
						const diffuseFileDataID = materialIDs[i];
						const heightFileDataID = heightIDs[i];

						const mat = materials[i] = { scale: 1, heightScale: 0, heightOffset: 1 };
						mat.diffuseTex = await loadTexture(diffuseFileDataID);

						if (texParams && texParams[i]) {
							const params = texParams[i];
							mat.scale = Math.pow(2, (params.flags & 0xF0) >> 4);

							if (params.height !== 0 || params.offset !== 1) {
								mat.heightScale = params.height;
								mat.heightOffset = params.offset;
								mat.heightTex = heightFileDataID ? await loadTexture(heightFileDataID) : mat.diffuseTex;
							}
						}
					}

					const aVertexPosition = gl.getAttribLocation(glShaderProg, 'aVertexPosition');
					const aTexCoord = gl.getAttribLocation(glShaderProg, 'aTextureCoord');
					const aVertexColor = gl.getAttribLocation(glShaderProg, 'aVertexColor');

					const uLayers = new Array(4);
					const uScales = new Array(4);
					const uHeights = new Array(4);
					const uBlends = new Array(4);

					for (let i = 0; i < 4; i++) {
						uLayers[i] = gl.getUniformLocation(glShaderProg, 'pt_layer' + i);
						uScales[i] = gl.getUniformLocation(glShaderProg, 'layerScale' + i);
						uHeights[i] = gl.getUniformLocation(glShaderProg, 'pt_height' + i);

						if (i > 0)
							uBlends[i] = gl.getUniformLocation(glShaderProg, 'pt_blend' + i);
					}

					const uHeightScale = gl.getUniformLocation(glShaderProg, 'pc_heightScale');
					const uHeightOffset = gl.getUniformLocation(glShaderProg, 'pc_heightOffset');
					const uTranslation = gl.getUniformLocation(glShaderProg, 'uTranslation');
					const uResolution = gl.getUniformLocation(glShaderProg, 'uResolution');
					const uZoom = gl.getUniformLocation(glShaderProg, 'uZoom');

					if (splitTextures) {
						glCanvas.width = quality / 16;
						glCanvas.height = quality / 16;
					} else {
						glCanvas.width = quality;
						glCanvas.height = quality;
					}

					clearCanvas();

					gl.uniform2f(uResolution, TILE_SIZE, TILE_SIZE);

					const vertexBuffer = gl.createBuffer();
					gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
					gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
					gl.enableVertexAttribArray(aVertexPosition);
					gl.vertexAttribPointer(aVertexPosition, 3, gl.FLOAT, false, 0, 0);

					const uvBuffer = gl.createBuffer();
					gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
					gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvsBake), gl.STATIC_DRAW);
					gl.enableVertexAttribArray(aTexCoord);
					gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);

					const vcBuffer = gl.createBuffer();
					gl.bindBuffer(gl.ARRAY_BUFFER, vcBuffer);
					gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertexColors), gl.STATIC_DRAW);
					gl.enableVertexAttribArray(aVertexColor);
					gl.vertexAttribPointer(aVertexColor, 4, gl.FLOAT, false, 0, 0);

					const firstChunk = rootAdt.chunks[0];
					const deltaX = firstChunk.position[1] - TILE_SIZE;
					const deltaY = firstChunk.position[0] - TILE_SIZE;

					if (!splitTextures)
						gl.uniform2f(uTranslation, -deltaX, -deltaY);

					gl.uniform1f(uZoom, splitTextures ? 0.0625 : 1);

					let chunkID = 0;
					for (let x = 0; x < 16; x++) {
						for (let y = 0; y < 16; y++) {
							if (splitTextures) {
								const ofsX = -deltaX - (CHUNK_SIZE * 7.5) + (y * CHUNK_SIZE);
								const ofsY = -deltaY - (CHUNK_SIZE * 7.5) + (x * CHUNK_SIZE);

								gl.uniform2f(uTranslation, ofsX, ofsY);
							}

							const chunkIndex = (x * 16) + y;
							const texChunk = texAdt.texChunks[chunkIndex];
							const indices = chunkMeshes[chunkIndex];

							const alphaLayers = texChunk.alphaLayers || [];
							const alphaTextures = new Array(alphaLayers.length);

							for (let i = 1; i < alphaLayers.length; i++) {
								gl.activeTexture(gl.TEXTURE3 + i);

								const alphaTex = bindAlphaLayer(alphaLayers[i]);
								gl.bindTexture(gl.TEXTURE_2D, alphaTex);
								
								gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
								gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

								gl.uniform1i(uBlends[i], i + 3);

								// Store to clean up after render.
								alphaTextures[i] = alphaTex;
							}

							const texLayers = texChunk.layers;
							const heightScales = new Array(4).fill(1);
							const heightOffsets = new Array(4).fill(1);

							for (let i = 0, n = texLayers.length; i < n; i++) {
								const mat = materials[texLayers[i].textureId];
								gl.activeTexture(gl.TEXTURE0 + i);
								gl.bindTexture(gl.TEXTURE_2D, mat.diffuseTex);

								gl.uniform1i(uLayers[i], i);
								gl.uniform1f(uScales[i], mat.scale);

								if (mat.heightTex) {
									gl.activeTexture(gl.TEXTURE7 + i);
									gl.bindTexture(gl.TEXTURE_2D, mat.heightTex);

									gl.uniform1i(uHeights[i], 7 + i);
									heightScales[i] = mat.heightScale;
									heightOffsets[i] = mat.heightOffset;
								}
							}

							gl.uniform4f(uHeightScale, ...heightScales);
							gl.uniform4f(uHeightOffset, ...heightOffsets);

							const indexBuffer = gl.createBuffer();
							gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
							gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
							gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);

							unbindAllTextures();
							
							// Destroy alpha layers rendered for the tile.
							for (const tex of alphaTextures)
								gl.deleteTexture(tex);

							// Save this individual chunk.
							if (splitTextures) {
								const tilePath = path.join(dir, 'tex_' + this.tileID + '_' + (chunkID++) + '.png');

								if (config.overwriteFiles || !await generics.fileExists(tilePath))
									await saveCanvas(tilePath);
							}
						}
					}

					// Save the completed tile.
					if (!splitTextures)
						await saveCanvas(path.join(dir, 'tex_' + this.tileID + '.png'));

					// Clear buffer.
					gl.bindBuffer(gl.ARRAY_BUFFER, null);

					// Delete loaded textures.
					for (const mat of materials)
						gl.deleteTexture(mat.texture);
				}
			}			
		}

		// Export dooads / WMOs.
		if (config.mapsIncludeWMO || config.mapsIncludeM2) {
			const objectCache = new Set();

			const csvPath = path.join(dir, 'adt_' + this.tileID + '_ModelPlacementInformation.csv');
			returnArray[3] = csvPath;
			if (config.overwriteFiles || !await generics.fileExists(csvPath)) {
				const csv = new CSVWriter(csvPath);
				csv.addField('ModelFile', 'PositionX', 'PositionY', 'PositionZ', 'RotationX', 'RotationY', 'RotationZ', 'ScaleFactor', 'ModelId', 'Type');

				if (config.mapsIncludeM2) {
					log.write('Exporting %d doodads for ADT...', objAdt.models.length);
					for (const model of objAdt.models) {
						const fileDataID = model.mmidEntry;		
						let fileName = listfile.getByID(fileDataID);

						try {	

							if (fileName !== undefined) {
								// Replace M2 extension with OBJ.
								fileName = ExportHelper.replaceExtension(fileName, '.obj');
							} else {
								// Handle unknown file.
								fileName = 'unknown/' + fileDataID + '.obj';
							}

							const modelPath = ExportHelper.getExportPath(fileName);

							// Export the model if we haven't done so for this export session.
							if (!objectCache.has(fileDataID)) {
								const m2 = new M2Exporter(await casc.getFile(fileDataID));
								await m2.exportAsOBJ(modelPath);
								objectCache.add(fileDataID);
							}

							csv.addRow({
								ModelFile: path.relative(dir, modelPath),
								PositionX: model.position[0],
								PositionY: model.position[1],
								PositionZ: model.position[2],
								RotationX: model.rotation[0],
								RotationY: model.rotation[1],
								RotationZ: model.rotation[2],
								ScaleFactor: model.scale / 1024,
								ModelId: model.uniqueId,
								Type: 'm2'
							});
						} catch {
							log.write('Failed to export %s [%d]', fileName, fileDataID);							
						}
					}
				}

				if (config.mapsIncludeWMO) {
					log.write('Exporting %d WMOs for ADT...', objAdt.worldModels.length);

					const usingNames = !!objAdt.wmoNames;
					for (const model of objAdt.worldModels) {
						let fileDataID;
						let fileName;

						try {
							if (usingNames) {
								fileName = objAdt.wmoNames[objAdt.wmoOffsets[model.mwidEntry]];
								fileDataID = listfile.getByFilename(fileName);
							} else {
								fileDataID = model.mwidEntry;
								fileName = listfile.getByID(fileDataID);
							}

							if (fileName !== undefined) {
								// Replace WMO extension with OBJ.
								fileName = ExportHelper.replaceExtension(fileName, '_set' + model.doodadSet + '.obj');
							} else {
								// Handle unknown WMO files.
								fileName = 'unknown/' + fileDataID + '_set' + model.doodadSet + '.obj';
							}

							const modelPath = ExportHelper.getExportPath(fileName);
							const cacheID = fileDataID + '-' + model.doodadSet;

							if (!objectCache.has(cacheID)) {
								const data = await casc.getFile(fileDataID);
								const wmo = new WMOExporter(data, fileDataID);

								if (config.mapsIncludeWMOSets)
									wmo.setDoodadSetMask({ [model.doodadSet]: { checked: true } });

								await wmo.exportAsOBJ(modelPath);
								objectCache.add(cacheID);
							}

							csv.addRow({
								ModelFile: path.relative(dir, modelPath),
								PositionX: model.position[0],
								PositionY: model.position[1],
								PositionZ: model.position[2],
								RotationX: model.rotation[0],
								RotationY: model.rotation[1],
								RotationZ: model.rotation[2],
								ScaleFactor: model.scale / 1024,
								ModelId: model.uniqueId,
								Type: 'wmo'
							});
						} catch {
							log.write('Failed to export %s [%d]', fileName, fileDataID);
						}
					}
				}

				await csv.write();
			} else {
				log.write('Skipping model placement export %s (file exists, overwrite disabled)', csvPath);
			}
		}

		// Prepare foliage data tables if needed.
		if (config.mapsIncludeFoliage && !hasLoadedFoliage)
			await loadFoliageTables();

		// Export foliage.
		if (config.mapsIncludeFoliage && isFoliageAvailable) {
			const foliageExportCache = new Set();
			const foliageDir = path.join(dir, 'foliage');
			
			log.write('Exporting foliage to %s', foliageDir);

			for (const chunk of texAdt.texChunks) {
				// Skip chunks that have no layers?
				if (!chunk.layers)
					continue;

				for (const layer of chunk.layers) {
					// Skip layers with no effect.
					if (!layer.effectID)
						continue;

					const groundEffectTexture = dbTextures.getRow(layer.effectID);
					if (!groundEffectTexture || !Array.isArray(groundEffectTexture.DoodadID))
						continue;

					for (const doodadEntryID of groundEffectTexture.DoodadID) {
						// Skip empty fields.
						if (!doodadEntryID)
							continue;

						const groundEffectDoodad = dbDoodads.getRow(doodadEntryID);
						if (groundEffectDoodad) {
							const modelID = groundEffectDoodad.ModelFileID;
							if (!modelID || foliageExportCache.has(modelID))
								continue;

							const modelName = path.basename(listfile.getByID(modelID));
							const data = await casc.getFile(modelID);

							const exporter = new M2Exporter(data);
							const modelPath = ExportHelper.replaceExtension(modelName, '.obj');
							await exporter.exportAsOBJ(path.join(foliageDir, modelPath));

							foliageExportCache.add(modelID);
						}
					}
				}
			}
		}
		return returnArray;
	}

	/**
	 * Clear internal tile-loading cache.
	 */
	static clearCache() {
		wdtCache.clear();
	}

	InsertArray(big, small, x, y) {
		if (small.length + y > big.length || small[0].length + x > big[0].length){
			log.write("smallArray will not fit");
			return big;
		}			
		small.forEach((a, i) => a.forEach((v, j) => big[y + i][x + j] = v));
		
		for (var i = 0; i < small.length; i++){
			var xRow = small[i];
			for (var j = 0; j < xRow.length; j++){				
				if (small[j] === undefined){
					log.write("smallArray[" + j + "] is undefined!");
				}				
			}
		}

		return big;
	}

	Normalize(val, max, min) { return (val - min) / (max - min); }
}

module.exports = ADTExporter4x4;