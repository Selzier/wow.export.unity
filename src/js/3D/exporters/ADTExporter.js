/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
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
const TGA = require('../../2D/tga');
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
const M2Exporter = require('../../3D/exporters/M2Exporter');
const WMOExporter = require('../../3D/exporters/WMOExporter');
const CSVWriter = require('../../3D/writers/CSVWriter');
const { SSL_OP_SSLEAY_080_CLIENT_DH_BUG } = require('constants');
const LoaderGenerics = require('../loaders/LoaderGenerics');

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

class ADTExporter {
	/**
	 * Construct a new ADTLoader instance.
	 * @param {number} mapID 
	 * @param {string} mapDir 
	 * @param {number} tileIndex 
	 */
	constructor(mapID, mapDir, tileIndex) {
		this.mapID = mapID;
		this.mapDir = mapDir;
		this.tileX = tileIndex % MAP_SIZE;
		this.tileY = Math.floor(tileIndex / MAP_SIZE);
		this.tileID = this.tileY + '_' + this.tileX;
		this.tileIndex = tileIndex;
	}

	/**
	 * Export the ADT tile.
	 * @param {string} dir Directory to export the tile into.
	 * @param {number} textureRes
	 */
	async export(dir, quality) {
		const casc = core.view.casc;
		const config = core.view.config;

		const prefix = util.format('world/maps/%s/%s', this.mapDir, this.mapDir);

		// Load the WDT. We cache this to speed up exporting large amounts of tiles
		// from the same map. Make sure ADTLoader.clearCache() is called after exporting.
		let wdt = wdtCache.get(this.mapDir);
		if (!wdt) {
			wdt = new WDTLoader(await casc.getFileByName(prefix + '.wdt'));
			await wdt.load();
			wdtCache.set(this.mapDir, wdt);
		}

		console.log(wdt);
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

		// Need to save height values to JSON
		var heightmapJSON = '{ "heightmap" : [';
		var testCount = 0;

		// Writing a 257x257 image in 17x17 overlapping chunks
		var bytesPerPixel     = 4;      // Each pixel has a R,G,B,A byte
		var bytesPerColumn    = 18496; // A 'column' is 257 pixels vertical (chunk): bytesPerRow * b
		var bytesPerRow       = 1028;   // A 'row' is 257 pixels horizontal (chunk): a * 4
		var bytesPerSubColumn = 1156;  // A 'subcolumn' is 17 pixels vertical (subchunk): bytesPerSubRow * b
		var bytesPerSubRow    = 68;    // A 'subrow' is 17 pixels horizontal (subchunk): b * 4

		// Create a 2D canvas for drawing the alpha maps.
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d');

		// Heightmaps will be 272x272, we're not up-scaling here.
		canvas.width = 257;
		canvas.height = 257;
		var imageData = ctx.createImageData(257, 257);
		log.write("imageData Length: " + imageData.data.length);

		for (var i = 0; i < imageData.data.length; i += 4) {
			imageData.data[i + 0] = 255;
			imageData.data[i + 1] = 0;
			imageData.data[i + 2] = 0;
			imageData.data[i + 3] = 255;
		}

		for (let x = 0; x < 16; x++) {	
			for (let y = 0; y < 16; y++) {				
				/*
				for (let j = y * bytesPerColumn; j < (y * bytesPerColumn) + bytesPerColumn; j += bytesPerRow) { // 272 pixels wide, 17 pixels high = 4624 * 4 bytes = 18496 (looping y axis)
					for (let i = x * bytesPerSubRow; i < (x * bytesPerSubRow) + bytesPerSubRow; i += bytesPerPixel) { // 17 pixels, 4 bytes each = 68
						var yloop = ((j / bytesPerRow) - (y * bytesPerColumn) / bytesPerRow);
						var xloop = ((i / 4) - ((x * bytesPerSubRow) / 4));
						var pixelIndex = (yloop * 16) + xloop;
						//log.write(pixelIndex);
						//imageData.data[(pixelIndex) + 0] = 255;
						//imageData.data[(pixelIndex) + 1] = 255;
						//imageData.data[(pixelIndex) + 2] = 255;
						//imageData.data[(pixelIndex) + 3] = 255;
					}
				}*/
			}
		}
			
		var vertexHeightList = [66049]; // Some are overlapping
		var hCount = 0;

		let ofs = 0;
		let chunkID = 0;
		for (let x = 0, midX = 0; x < 16; x++) { // chunk
			for (let y = 0; y < 16; y++) { // chunk
				const indices = [];
				//log.write("X: " + x + ", Y: " + y);
				const chunkIndex = (x * 16) + y;
				const chunk = rootAdt.chunks[chunkIndex];

				const chunkX = chunk.position[0];
				const chunkY = chunk.position[1];
				const chunkZ = chunk.position[2];						

				for (let row = 0, idx = 0; row < 17; row++) { // subchunk
					const isShort = !!(row % 2);
					const colCount = isShort ? 8 : 9;
					//log.write("Row: " + row + ", IDX: " + idx);

					for (let col = 0; col < colCount; col++) {
						//log.write("Col: " + col + ", colCount: " + colCount);
						let vx = chunkY - (col * UNIT_SIZE);
						let vy = chunk.vertices[idx] + chunkZ;
						let vz = chunkX - (row * UNIT_SIZE_HALF);

						if (isShort)
							vx -= UNIT_SIZE_HALF;

						const vIndex = midX * 3;
						vertices[vIndex + 0] = vx;
						vertices[vIndex + 1] = vy;
						vertices[vIndex + 2] = vz;

						// Saving heightmap data
						let vY = chunk.vertices[idx] + chunkZ;
						let vyMinus1 = chunk.vertices[idx-1] + chunkZ;
						let vyMinus8 = chunk.vertices[idx-8] + chunkZ;
						let vyMinus9 = chunk.vertices[idx-9] + chunkZ;
						let vyPlus8 = chunk.vertices[idx+8] + chunkZ;
						let vyPlus9 = chunk.vertices[idx+9] + chunkZ;

						/*if (x == 1 && y == 1){
							vY = chunk.vertices[idx-9] + chunkZ;
							vyMinus1 = chunk.vertices[idx-10] + chunkZ;
							vyMinus8 = chunk.vertices[idx-17] + chunkZ;
							vyMinus9 = chunk.vertices[idx-18] + chunkZ;
							vyPlus8 = chunk.vertices[idx-1] + chunkZ;
							vyPlus9 = chunk.vertices[idx] + chunkZ;
						}*/

						if (x < 15){
							// Long Column; Don't draw bottom row
							if (!isShort && y < 15 && row < 16){ // Long Column
								if (col == 0){
									// Vertex 0 - Upper Left
									vertexHeightList[hCount] = vY;
									hCount++;
								}else if (col < 8){
									// Down 1 vertex
									vertexHeightList[hCount] = (vyMinus1 + vy) / 2; // New Vertex in middle (531 = white)
									hCount++;
									vertexHeightList[hCount] = vY;
									hCount++;
								}else if (col == 8){ // Bottom Left Corner
									vertexHeightList[hCount] = (vyMinus1 + vY) / 2; // New Vertex in middle
									hCount++;
									//vertexHeightList[hCount] = vy; // Not drawing the bottom row of pixels
								}

							// Long Column; Include bottom row
							}else if (!isShort && y == 15 && row < 16){
								if (col == 0){
									// Vertex 0 - Upper Left
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
									vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; // New Vertex in middle // THESE ARE ALL WRONG
									hCount++;
									vertexHeightList[hCount] = vY; // THESE ARE ALL WRONG
									hCount++;
								}else if (col == 7){ // THESE ARE ALL WRONG
									vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; // New Vertex in middle / THESE ARE ALL WRONG
									hCount++;
									vertexHeightList[hCount] = vY; // THESE ARE ALL WRONG
									hCount++;
									vertexHeightList[hCount] = (vyMinus8 + vyPlus9) / 2; // THESE ARE ALL WRONG
									hCount++;
								}							
							}
						}
						else if (x == 15){ // Include Right Edge
							// Long Column; Don't draw bottom row
							if (!isShort && y < 15){ // Long Column
								if (col == 0){
									// Vertex 0 - Upper Left
									vertexHeightList[hCount] = vy;
									hCount++;
								}else if (col < 8){
									// Down 1 vertex
									vertexHeightList[hCount] = (vyMinus1 + vy) / 2; // New Vertex in middle
									hCount++;
									vertexHeightList[hCount] = vy;
									hCount++;
								}else if (col == 8){ // Bottom Left Corner
									vertexHeightList[hCount] = (vyMinus1 + vy) / 2; // New Vertex in middle
									hCount++;
									//vertexHeightList[hCount] = vy; // Not drawing the bottom row of pixels
								}

							// Long Column; Include bottom row
							}else if (!isShort && y == 15){
								if (col == 0){
									// Vertex 0 - Upper Left
									vertexHeightList[hCount] = vy; // Never used???
									hCount++;
								}else if (col < 8){
									// Down 1 vertex
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
						
						/*
						//heightList[hCount-1] = vy - ((heightList[hCount-2] + vy) /2);
						if (isShort && col == 7){
							heightList[hCount-1] = vy;
							heightList[hCount] = vy;
							heightList[hCount+1] = vy; // Last pixel of short column need a before and after pixel
							hCount+=2;
						}else if (isShort){
							heightList[hCount-1] = vy;
							heightList[hCount] = vy;
							hCount+=2;
						//}else if( !isShort && col == 8 ){
						//	heightList[hCount] = vy;
						//	hCount+=2; // 2?
						}else if (!isShort){
							heightList[hCount] = vy;
							heightList[hCount+1] = vy;
							hCount+=2;
						}*/

						heightmapJSON += vy + ','; // Save Y value to json
						
						const normal = chunk.normals[idx];
						normals[vIndex + 0] = normal[0] / 127;
						normals[vIndex + 1] = normal[1] / 127;
						normals[vIndex + 2] = normal[2] / 127;

						const cIndex = midX * 4;
						if (chunk.vertexShading) {
							// Store vertex shading in BGRA format.
							const color = chunk.vertexShading[idx];
							vertexColors[cIndex + 0] = color.b / 255;
							vertexColors[cIndex + 1] = color.g / 255;
							vertexColors[cIndex + 2] = color.r / 255;
							vertexColors[cIndex + 3] = color.a / 255;
						} else {
							// No vertex shading, default to this.
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
				log.write("TotalPixelCount / hCount: " + hCount);
			}
		}
				
		hCount = 0;
		for (i = 0; i < 66048; i++){
			if (isNaN(vertexHeightList[i])){
				log.write(i + " is NOT a valid number: NaN!");
				vertexHeightList[i] = 531;
			}
			
		}
		log.write("VertexHeightList length: " + vertexHeightList.length);
		var maxHeight = (Math.max(...vertexHeightList));
		var minHeight = (Math.min(...vertexHeightList));
		log.write("Max: " + maxHeight + ", Min: " + minHeight);		

		//imageData = ctx.createImageData(257, 257);
		var heightList = [66049];
		var vIndex = 0;				
		/*for (i = 0; i < 66048; i++){
			var normalized = this.Normalize(vertexHeightList[Math.floor(vIndex)], maxHeight, minHeight);
			heightList[i] = normalized;
			vIndex += 0.5;
			imageData.data[(i * 4) + 0] = normalized * 255;
			imageData.data[(i * 4) + 1] = normalized * 255;
			imageData.data[(i * 4) + 2] = normalized * 255; //normalized * 255;
			imageData.data[(i * 4) + 3] = 255;
		}*/

		/*for (let x = 0, midX = 0; x < 16; x++) { // chunk
			for (let y = 0; y < 16; y++) { // chunk
				for (let row = 0, idx = 0; row < 16; row++) { // subchunk
					for (let col = 0; col < 16; col ++){ // subchunk
						var normalized = this.Normalize(vertexHeightList[hCount], maxHeight, minHeight);
						imageData.data[(hCount * 4) + 0] = normalized * 255;
						imageData.data[(hCount * 4) + 1] = normalized * 255;
						imageData.data[(hCount * 4) + 2] = normalized * 255; //normalized * 255;
						imageData.data[(hCount * 4) + 3] = 255;
						hCount++;
					}
				}
			}
		}*/

		var index = 0;
		var shortColumn = false;
		var vertexCounter = 0;
		/*
		for (i = 0; i < vertexHeightList.length; i++) { // 37120
			if (!shortColumn){ // Long Column (9 verts)
				if (vertexCounter < 8){					
					var normalized = this.Normalize(vertexHeightList[i], maxHeight, minHeight);
					var normalized2 = this.Normalize(vertexHeightList[i+1], maxHeight, minHeight);
					var midpoint = (normalized + normalized2) / 2;
					heightList[index] = normalized;
					heightList[index+1] = midpoint;
					index+=2;
				} else if (vertexCounter == 8){
					var normalized = this.Normalize(vertexHeightList[i], maxHeight, minHeight);
					heightList[index] = normalized;
					index+=1;
					shortColumn = true;
					vertexCounter = 0;
				}
			}else{ // Short Column (8 verts)
				if (vertexCounter < 7){
					var normalized = this.Normalize(vertexHeightList[i], maxHeight, minHeight); // center vert				
					var normalized2 = this.Normalize(vertexHeightList[i-9], maxHeight, minHeight); // upper left vert
					var normalized3 = this.Normalize(vertexHeightList[i+8], maxHeight, minHeight); // upper right vert
					var midpoint = (normalized2 + normalized3) / 2;
	
					heightList[index-1] = midpoint;
					heightList[index] = normalized;
					index+=2;
				}else if (vertexCounter == 7){
					var normalized = this.Normalize(vertexHeightList[i], maxHeight, minHeight); // center vert				
					var normalized2 = this.Normalize(vertexHeightList[i-9], maxHeight, minHeight); // upper left vert
					var normalized3 = this.Normalize(vertexHeightList[i+8], maxHeight, minHeight); // upper right vert
					var normalized4 = this.Normalize(vertexHeightList[i-8], maxHeight, minHeight); // lower left vert
					var normalized5 = this.Normalize(vertexHeightList[i+9], maxHeight, minHeight); // lower right vert
					var midpoint = (normalized2 + normalized3) / 2;
					var midpoint2 = (normalized4 + normalized5) / 2;
	
					heightList[index-1] = midpoint;
					heightList[index] = normalized;
					heightList[index+1] = midpoint2;
					index+=3;
					shortColumn = false;
					vertexCounter = 0;
				}
			}			
			vertexCounter++
		}

		log.write("Total pixelcount: " + index);
		*/
		var countpixels = 0;
		// DRAW HEIGHTMAP
		for (let x = 0, midX = 0; x < 16; x++) { // chunk
			for (let y = 0; y < 16; y++) { 		// chunk
				
				var xSize = 16;
				var ySize = 16;
				if (y == 15 && x < 15){							
					imageData = ctx.createImageData(16, 17); // Inlude 17 pixels, bottom row
					ySize = 17;
				}else if (x == 15 && y < 15){
					imageData = ctx.createImageData(17, 16); // Inlude 17 pixels, right edge
					xSize = 17;
				}else if (x == 15 && y == 15){
					imageData = ctx.createImageData(17, 17); // Inlude 17 pixels, bottom row and right edge
					xSize = 17;
					ySize = 17;
				}else{
					imageData = ctx.createImageData(16, 16); // 16x16 block
				}				
				
				var color =  x * y;
				for (let col = 0; col < xSize; col ++){ // subchunk Y
					for (let row = 0, idx = 0; row < ySize; row++) { // subchunk X
						var normalized = this.Normalize(vertexHeightList[hCount], maxHeight, minHeight);
						var pixIndex = ((row * xSize) + (col)); //((x * bytesPerSubColumn) + (y * bytesPerRow) + row + col);

						imageData.data[(pixIndex * 4) + 0] = normalized * 255;
						imageData.data[(pixIndex * 4) + 1] = normalized * 255;
						imageData.data[(pixIndex * 4) + 2] = normalized * 255; //normalized * 255;
						imageData.data[(pixIndex * 4) + 3] = 255;

						//log.write(normalized);
						hCount++;
						//color++;						
						idx++; // not using
						midX++; // not using
						countpixels++;
						/*if ((x * 16) + y == 16){
							imageData.data[(pixIndex * 4) + 0] = 255;
							imageData.data[(pixIndex * 4) + 1] = 0;
							imageData.data[(pixIndex * 4) + 2] = 0; //normalized * 255;
							imageData.data[(pixIndex * 4) + 3] = 255;
						}*/
					}
				}
				log.write("Countpixels: " + countpixels);
				ctx.putImageData(imageData, x * 16, y * 16);
			}
		}

		// Heightmap Image

		//ctx.putImageData(imageData, 0, 0);
		const hmiprefix = this.tileID + '_' + (chunkID++);
		const tilePath = path.join(dir, 'heightmap_' + hmiprefix + '.png');

		const buf = await BufferWrapper.fromCanvas(canvas, 'image/png');
		await buf.writeToFile(tilePath);

		heightmapJSON = heightmapJSON.substring(0, heightmapJSON.length - 1); // remove tailing comma
		heightmapJSON += ']}';

		//log.write(testCount);
		//log.write(heightmapJSON);

		var heightmapParsedJSON = JSON.parse(heightmapJSON);		

		const jsonPath = path.join(dir, 'heightData_' + this.tileID + '.json');
		try { fs.writeFileSync(jsonPath, JSON.stringify(heightmapParsedJSON));
			} catch (err) { log.write(err); }		

		if (!splitTextures && quality !== -1)
			mtl.addMaterial('tex_' + this.tileID, 'tex_' + this.tileID + '.png');

		obj.setVertArray(vertices);
		obj.setNormalArray(normals);
		obj.setUVArray(uvs);

		if (!mtl.isEmpty)
			obj.setMaterialLibrary(path.basename(mtl.out));
		
		await obj.write(config.overwriteFiles);
		await mtl.write(config.overwriteFiles);

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
					await blp.saveToFile(path.join(dir, diffuseFileDataID + '.png'), 'image/png', false);
					const mat = materials[i] = { scale: 1, id: diffuseFileDataID };
					if (texParams && texParams[i]) {
						const params = texParams[i];
						mat.scale = Math.pow(2, (params.flags & 0xF0) >> 4);
					}
				}
				
				var pixelSet = new Uint8ClampedArray(1024 * 1024 * 4);
				var pixelData = new Array(Math.ceil(materialIDs.length/4));
				log.write(Math.ceil(materialIDs.length/4));
				log.write(pixelData.length);
				for (var p = 0; p < pixelData.length; p++){
					pixelData[p] = new Uint8ClampedArray(1024 * 1024 * 4);
					log.write("Image" + p);
				}
				//pixelData = new Array<new Uint8ClampedArray(1024 * 1024 * 4)>();				
				// 1024x1024 image with 4 bytes per pixel
				//var pixelData = new Array<new Uint8ClampedArray(1024 * 1024 * 4)>(Math.ceil(materialIDs/4)); // We will need a separate TGA image for every 4 textures
				//Uint8ClampedArray(1024 * 1024 * 4);

				// Writing a 1024x1024 image in 64x64 chunks
				var bytesPerPixel     = 4;      // Each pixel has a R,G,B,A byte
				var bytesPerColumn    = 262144; // A 'column' is 1024 pixels vertical (chunk) bytesPerRow * b
				var bytesPerRow       = 4096;   // A 'row' is 1024 pixels horizontal (chunk) a * 4
				var bytesPerSubColumn = 16384;  // A 'subcolumn' is 64 pixels vertical (subchunk) bytesPerSubRow * b
				var bytesPerSubRow    = 256;    // A 'subrow' is 64 pixels horizontal (subchunk) b * 4
				
				let chunkID = 0;
				const lines = [];
				var tga = new TGA(fs.readFileSync('./src/images/TGATemplate.tga'));
				
				// New JSON file to save material data
				var materialJSON = '{ "chunkData" : {';

				// Populate the JSON data for all 256 subchunks
				for (let x = 0; x < 16; x++) {	
					for (let y = 0; y < 16; y++) {
						const chunkIndex = (y * 16) + x;
						const texChunk = texAdt.texChunks[chunkIndex];
						
						// New parent object named with index "0", "1", "2", etc
						materialJSON += '"' + chunkIndex + '": [';
						
						if (texChunk.layers.length == 0) {
							materialJSON += '{"id":"' + 0 + '","scale":"' + 0 + '"},';
						}

						for (let i = 0, n = texChunk.layers.length; i < n; i++) { // COULD BE ZERO!!!
							const mat = materials[texChunk.layers[i].textureId];
							materialJSON += '{"id":"' + mat.id + '","scale":"' + mat.scale + '"},';
							lines.push([chunkIndex, i, mat.id, mat.scale].join(','));
							//materialJSON += '{ "chunkIndex":"' + chunkIndex + '", "channel":"' + i + '", "id":"' + mat.id + '", "scale":"' + mat.scale + '" },';
						}
						materialJSON = materialJSON.substring(0, materialJSON.length - 1); // remove tailing comma
						materialJSON += '],'; // Close the subchunk array
					}
				}				
				materialJSON = materialJSON.substring(0, materialJSON.length - 1); // remove tailing comma
				var fullJSON = materialJSON + '}, "splatmapData" : {'; // create JSON data to include splatmap data							
				
				materialJSON += '}}'; // Close the JSON data
				var matJSON = JSON.parse(materialJSON);

				for (let q=0; q < materialIDs.length; q++){
					fullJSON += '"id' + q + '":"' + materialIDs[q] + '",';
					//log.write(materialIDs[q]);
				}
				fullJSON = fullJSON.substring(0, fullJSON.length - 1); // remove tailing comma
				fullJSON += '}}'; // Close the JSON data
				log.write(fullJSON);
				var fullParsedJSON = JSON.parse(fullJSON);

				/*
				// Sort JSON data by chunkIndex	
				matJSON.chunkData.sort(function(a, b) {
					var keyA = parseInt(a.chunkIndex),
						keyB = parseInt(b.chunkIndex);
					// Compare the 2 dates
					if (keyA < keyB) return -1;
					if (keyA > keyB) return 1;
					return 0;
				});*/
				log.write("Databegin: ");
				/*
				var matIds = [];
				for (var i in matJSON.chunkData) {
					if (matJSON.chunkData[i].channel == 0){
						//log.write(JSON.stringify(matJSON.chunkData[i].id));
						matIds.push(matJSON.chunkData[i].id);
					}
				}
				
				// Checking all 256 subchunks to make sure the Base Material is the same
				var uniqueBaseMatIds = Array.from(new Set(matIds));
				if (uniqueBaseMatIds.length > 1){
					log.write("WARNING! Found more than 1 Base Materials for " + prefix);
				}
								
				for (var i in matJSON.chunkData) {
					if (matJSON.chunkData[i].channel != 0){
						//log.write(JSON.stringify(matJSON.chunkData[i].id));
						matIds.push(matJSON.chunkData[i].id);
					}
				}

				var uniqueAlphaMatIds = Array.from(new Set(matIds));
				for (var i in uniqueAlphaMatIds){
					//log.write("Texture" + i + ": " + uniqueAlphaMatIds[i]);
					// 0 is base texture
					// 1-x are alpha textures
					// If more than 1 Base Materials are found, this will be incorrect
				}*/

				
				// Now before we draw each sub-chunk to TGA, we need to check it's texture list in json.
				// Based on what order the textures are for that sub-chunk, we may need to draw RGBA in a different order than 0,1,2,3								

				// Loop Y first so we go left to right, top to bottom. Loop 16x16 subchunks to get the full chunk
				for (let x = 0; x < 16; x++) {	
					for (let y = 0; y < 16; y++) {
							
						const chunkIndex = (y * 16) + x;
						const texChunk = texAdt.texChunks[chunkIndex];
						const alphaLayers = texChunk.alphaLayers || [];
						const textureLayers = texChunk.layers;						

						/*
						var texIndex = materialIDs.indexOf(parseInt(matJSON.chunkData[chunkIndex][1].id)); // doesn't work!						
						//log.write("Index: " + texIndex + ", Alphalayer Length: " + alphaLayers.length);
						if(alphaLayers[texIndex] === undefined) {
							log.write(chunkIndex + " alphalayer " + texIndex + " undefined! TexID: " + matJSON.chunkData[chunkIndex][1].id);
						}
						//log.write(alphaLayers[texIndex][0]);
						
						for (let m = 0; m < matJSON.chunkData[chunkIndex].length; m++){
							for (let n = 0; n < materialIDs.length; n++){
								if (materialIDs[n] == matJSON.chunkData[chunkIndex][m].id){
									// Match
									//log.write("FoundMatch. Subchunk " + chunkIndex + " channel " + m + " has texture " + materialIDs[n]);
									// Need to connect this to the pixel loop below
								}								
							}							
						}*/

						//log.write(chunkIndex + ": " + matJSON.chunkData[chunkIndex][1].id); // This is correct	

						// If there is no texture data just skip it
						if (textureLayers.length > 0) {
							// If there is texture data, we need a base layer of red to flood the subchunk 							
							for (let j = y * bytesPerColumn; j < (y * bytesPerColumn) + bytesPerColumn; j += bytesPerRow) { // 1024 pixels wide, 64 pixels high = 65536 * 4 bytes = 262144 (looping y axis)
								// Now we need to loop the x axis, 64 pixels long								
								for (let i = x * bytesPerSubRow; i < (x * bytesPerSubRow) + bytesPerSubRow; i += bytesPerPixel) { // 64 pixels, 4 bytes each = 256
									var yloop = ((j / bytesPerRow) - (y * bytesPerColumn) / bytesPerRow);
									var xloop = ((i / 4) - ((x * bytesPerSubRow) / 4));
									var alphaIndex = (yloop * 64) + xloop;
									
									// The first TGA image will have base texture flooded with red.
									if (pixelData[0][j + i + 0] === undefined){
										log.write("pixeldata[0]" + [j + i + 0] + " is undefined!");
									}
									pixelData[0][j + i + 0] = 255; // Red: (186865) 
									//log.write("Made it here");
									
									// Need to check some value and match to a value in uniqueAlphaMatIds
									// What is this subchunk's layer 1 texture id?							
									// GREEN is the 2nd texture in the Texture Palette. For pvpzone02/31_31 the palette is:
									
									//         materialIDs(0) materialIDs(1) materialIDs(2) materialIDs(3) 
									// Image 0, R: 186865      G: 186798      B: 186868      A: 186870 
									
									//         materialIDs(4) materialIDs(5)
									// Image 1, R: 186883      G: 188516 

									// Now we need to draw in the order of: matJSON.chunkData[chunkIndex][1].id, matJSON.chunkData[chunkIndex][2].id, etc
									// And subtract from the previous layer(s) while doing so
									// RBGA, RBGAs will be drawn in different orders for each chunkIndex

									// start at 1, flood red for layer 0
									for (var k = 1; k < matJSON.chunkData[chunkIndex].length; k++){
										// k = 1, random materialID. This could be any RGBA, RGBA color! 										
										if (matJSON.chunkData[chunkIndex][k] === undefined){
											log.write("error!...!");
										}else{
											//log.write("matJSON.chunkData[chunkIndex][k].id" + matJSON.chunkData[chunkIndex][k].id);
										}
										var currentID = matJSON.chunkData[chunkIndex][k].id;
										var currentIndex = -1;
										for (var l = 0; l < materialIDs.length; l++){
											if (materialIDs[l] == currentID){
												currentIndex = l;
											}
										}
										if (currentIndex == -1){
											log.write("ERROR: Index is still -1 after loop:" + currentID);
										}
										var texIndex = currentIndex;
										// alphaLayers is an array equal to length of textures and in the same order as materialIDs
										// each array item is an Array(64 * 64)
										// alphaLayers[0] is filled with red (255)

										// Red   / 0 has everything subtracted from it
										// Green / 1 has Blue & Alpha subtracted from it
										// Blue  / 2 has Alpha subtracted from it
										
										// Calculate image index, 1 TGA image for each 4 textures. index 0 includes base texture on channel 0
										var imageIndex = Math.floor(texIndex/4);

										// 0-3 RGBA. If imageIndex=0 this should not be 0 because that is basetexture
										var channelIndex = texIndex % 4;

										// array  whichTGA   Pixel|chanel
										if (pixelData[imageIndex] === undefined){
											log.write("pixelData[" + imageIndex +"] is undefined");
										}
										if (pixelData[imageIndex][j + i + channelIndex] === undefined){
											log.write("pixeldata[" + imageIndex + "]" + ", channelIndex:" + channelIndex + " is undefined!");
										}
										if (alphaLayers[k] === undefined){
											log.write("alphaLayers[k] is undefined: " + texIndex + ". Alphalayers length: " + alphaLayers.length + ", Chunk: " + chunkIndex);
										}
										if (alphaLayers[k][alphaIndex] === undefined){
											log.write("alphaLayers[" + k + "] alphaIndex[" + alphaIndex + "] is undefined!");
										}
										// Write the actual pixel data
										pixelData[imageIndex][j + i + channelIndex] = alphaLayers[k][alphaIndex];
										
										//for (var m = 0; m < imageIndex; m++){ // TGA Image Loop
											// Need to subtract all layers up to channelIndex
											// ChannelIndex is 0-3
											// example; imageIndex = 1;
											var subtractImages = imageIndex % 4; // subtract all 4 channels (full image)
											var subtractChannels = channelIndex - 1; // subtract only certain channels

											for (var m = 0; m < subtractImages; m++){ // All previous layers except this one
												pixelData[m][j + i + 0] -= alphaLayers[k][alphaIndex];
												pixelData[m][j + i + 1] -= alphaLayers[k][alphaIndex];
												pixelData[m][j + i + 2] -= alphaLayers[k][alphaIndex];
												pixelData[m][j + i + 3] -= alphaLayers[k][alphaIndex];
											}

											for (var n = 0; n < subtractChannels; n++){
												pixelData[imageIndex][j + i + n] -= alphaLayers[k][alphaIndex];
											}
										//}
									}

									/*
									if (textureLayers.length > 1) { // Green: (186798) 

									// Calculate this subchunks channel 1 texture id
										var channel1id = matJSON.chunkData[chunkIndex][1].id;
										var texIndex = materialIDs.indexOf(parseInt(matJSON.chunkData[chunkIndex][1].id)); // doesn't work!										
										
										if (texIndex < 0 || texIndex > 5){
											//log.write(texIndex);
										}
										//pixelData[j + i + 3] -= alphaLayers[1][alphaIndex];
										//pixelData[j + i + 2] -= alphaLayers[1][alphaIndex];
										pixelData[j + i + 1] = alphaLayers[1][alphaIndex]; 
										pixelData[j + i + 0] -= alphaLayers[1][alphaIndex];
									}
									
									if (textureLayers.length > 2) { // Blue										

										//pixelData[j + i + 3] -= alphaLayers[2][alphaIndex];
										pixelData[j + i + 2] = alphaLayers[2][alphaIndex];
										pixelData[j + i + 1] -= alphaLayers[2][alphaIndex];
										//pixelData[j + i + 0] -= alphaLayers[2][alphaIndex];
									}
									
									if (textureLayers.length > 3) { // Alpha										

										pixelData[j + i + 3] = alphaLayers[3][alphaIndex];
										pixelData[j + i + 2] -= alphaLayers[3][alphaIndex];
										//pixelData[j + i + 1] -= alphaLayers[3][alphaIndex];
										//pixelData[j + i + 0] -= alphaLayers[3][alphaIndex];
									}*/
								}
							}														
						}						
					}
				}
				
				/*
				for (let i = 0; i < matJSON.chunkData.length; i++){
					var object = matJSON.chunkData[i];
					for (var key in object){
						var name = key;
						var value = object[key];
						log.write(name + ": " + value);
					}
				}*/

				//var blah = matJSON.chunkData.sort((a,b) => matJSON.chunkData.filter(v => v===a.chunkIndex).length - matJSON.chunkData.filter(v => v===b.chunkIndex).length).pop();
				//log.write("Most Common: " + JSON.stringify(blah));
				log.write("finished loop");
				const jsonPath = path.join(dir, 'matData_' + prefix + '.json');
				try { fs.writeFileSync(jsonPath, JSON.stringify(fullParsedJSON));
					} catch (err) { console.error(err); }
				
				for (var t = 0; t < pixelData.length; t++) {
					const tgaPath = path.join(dir, 'splatmap_' + prefix + '_' + t.toString() + '.tga');
					tga.pixels = pixelData[t];
					var buftga = TGA.createTgaBuffer(tga.width, tga.height, tga.pixels);
					fs.writeFileSync(tgaPath, buftga);
				}

				const metaOut = path.join(dir, 'tex_' + prefix + '.csv');
				await fsp.writeFile(metaOut, lines.join('\n'), 'utf8');

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
	}

	/**
	 * Clear internal tile-loading cache.
	 */
	static clearCache() {
		wdtCache.clear();
	}

	Normalize(val, max, min) { return (val - min) / (max - min); }
}

module.exports = ADTExporter;