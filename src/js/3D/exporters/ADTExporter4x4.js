/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com> | Selzier <nurfacegames@gmail.com>
	License: MIT
	Build: node ./build.js win-x64
 */
const fsp = require('fs').promises;
const log = require('../../log');
const fs = require('fs');
const util = require('util');
const core = require('../../core');
const path = require('path');
const constants = require('../../constants');
const generics = require('../../generics');
const listfile = require('../../casc/listfile');
const DB_GroundEffectTexture = require('../../db/schema/GroundEffectTexture');
const DB_GroundEffectDoodad = require('../../db/schema/GroundEffectDoodad');

const BufferWrapper = require('../../buffer');
const BLPFile = require('../../casc/blp');
const WDTLoader = require('../loaders/WDTLoader');
const ADTLoader = require('../loaders/ADTLoader');
const OBJWriter = require('../writers/OBJWriter');
const MTLWriter = require('../writers/MTLWriter');
const WDCReader = require('../../db/WDCReader');
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
	// For unknown reasons, we have to store blpData as a variable. Inlining it into the parameter list causes issues, despite it being synchronous.
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
	for (let i = 0, j = 0, n = layer.length; i < n; i++, j += 4) { data[j + 0] = data[j + 1] = data[j + 2] = data[j + 3] = layer[i]; }
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
	constructor(mapID, mapDir, tileIndex, materialArrayFull) {
		this.mapID = mapID;
		this.mapDir = mapDir;
		this.tileX = tileIndex % MAP_SIZE;
		this.tileY = Math.floor(tileIndex / MAP_SIZE);
		this.tileID = this.tileY + '_' + this.tileX;
		this.tileIndex = tileIndex;
		this.materialArrayFull = materialArrayFull;
	}

	/**
	 * Export the ADT tile.
	 * @param {string} dir Directory to export the tile into.
	 * @param {number} textureRes
	 */
	async export(dir, quality) {
		var returnArray = new Array(8).fill(0);
		returnArray[0] = this.mapDir; 	// Zone name
		returnArray[1] = this.tileY; 	// ADT Y
		returnArray[2] = this.tileX; 	// ADT X
		returnArray[3] = ""; 			// path to _ModelPlacementInformation.csv
		returnArray[4] = ""; 			// path to _HeightData.json
		returnArray[5] = ""; 			// path to _MaterialData.json
		returnArray[6] = []; 			// Heightmap: 2x2 Array 1025x1025
		returnArray[7] = []; 			// PixelData Array
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
		if (rootFileDataID === 0 || tex0FileDataID === 0 || obj0FileDataID === 0) {
			throw new Error('Missing fileDataID for ADT files: ' + [rootFileDataID, tex0FileDataID, obj0FileDataID].join(', '));
		}

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
		
		var vertexHeightList = [66049]; // All heightmap points 257x257
		var hCount = 0; // height count, number of heightmap points saved
		let ofs = 0;
		let chunkID = 0;
		for (let x = 0, midX = 0; x < 16; x++) { // Chunk X
			for (let y = 0; y < 16; y++) { // Chunk Y
				const indices = [];
				const chunkIndex = (x * 16) + y;
				const chunk = rootAdt.chunks[chunkIndex];
				const chunkX = chunk.position[0];
				const chunkY = chunk.position[1];
				const chunkZ = chunk.position[2];

				for (let row = 0, idx = 0; row < 17; row++) { // Xubchunk X
					const isShort = !!(row % 2);
					const colCount = isShort ? 8 : 9;

					for (let col = 0; col < colCount; col++) { // Subchunk Y
						let vx = chunkY - (col * UNIT_SIZE);
						let vy = chunk.vertices[idx] + chunkZ;
						let vz = chunkX - (row * UNIT_SIZE_HALF);

						if (isShort) { vx -= UNIT_SIZE_HALF; }						
						const vIndex = midX * 3;
						vertices[vIndex + 0] = vx;
						vertices[vIndex + 1] = vy;
						vertices[vIndex + 2] = vz;

						//************************************************************************//
						// Populate Height Data
						//************************************************************************//
						let vY = chunk.vertices[idx] + chunkZ;
						let vyMinus1 = chunk.vertices[idx-1] + chunkZ;
						let vyMinus8 = chunk.vertices[idx-8] + chunkZ;
						let vyMinus9 = chunk.vertices[idx-9] + chunkZ;
						let vyPlus8 = chunk.vertices[idx+8] + chunkZ;
						let vyPlus9 = chunk.vertices[idx+9] + chunkZ;
						
						if (x < 15){ 																// DO NOT draw final right edge of pixels (x = 256)
							if (!isShort && y < 15 && row < 16) { 									// Long Column; DO NOT draw bottom row (16x16)
								if (col == 0) { 													// Top of 16x16 subchunk heightmap
									vertexHeightList[hCount] = vY; hCount++; 						// First pixel is first vertex
								} else if (col < 8) { 												// Middle of column
									vertexHeightList[hCount] = (vyMinus1 + vy) / 2; hCount++; 		// New pixel between 2 verts
									vertexHeightList[hCount] = vY; hCount++; 						// This pixel is at vertex position
								} else if (col == 8) { 												// Bottom of 16x16
									vertexHeightList[hCount] = (vyMinus1 + vY) / 2; hCount++; 		// New pixel between 2 verts
									// Not drawing pixel 17
								}
							} else if (!isShort && y == 15 && row < 16) { 							// Long Column; INCLUDE the bottom row (16x17)
								if (col == 0) {														// Top of 16x16 subchunk heightmap
									vertexHeightList[hCount] = vY; hCount++;						// First pixel is first vertex
								} else {
									vertexHeightList[hCount] = (vyMinus1 + vY) / 2; hCount++; 		// New pixel between 2 verts
									vertexHeightList[hCount] = vY; hCount++; 						// This pixel is at vertex position
								}							
							}else if (isShort && y < 15 && row < 16) { 								// Short Column; DO NOT draw bottom row (16x16)
								vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; hCount++;		// New pixel between 2 verts
								vertexHeightList[hCount] = vY; hCount++; 							// This pixel is at vertex position

							} else if (isShort && y == 15 && row < 16) { 							// Short Column; INCLUDE the bottom row (16x17)
								if (col < 7) {														// Middle of column
									vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; hCount++; 	// New pixel between 2 verts
									vertexHeightList[hCount] = vY; hCount++;						// This pixel is at vertex position
								} else if (col == 7) {												// Bottom of 16x16
									vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; hCount++;	// New pixel between 2 verts
									vertexHeightList[hCount] = vY; hCount++;						// This pixel is at vertex position
									vertexHeightList[hCount] = (vyMinus8 + vyPlus9) / 2; hCount++;  // New pixel between verts on the bottom
								}
							}
						}
						else if (x == 15) { 														// INCLUDE the final right edge of pixels (x = 257)
							if (!isShort && y < 15) { 												// Long Column; DO NOT draw bottom row (17x16)
								if (col == 0) {														// Top of 17x16 subchunk heightmap
									vertexHeightList[hCount] = vy; hCount++;						// First pixel is first vertex
								} else if (col < 8) {												// Middle of column
									vertexHeightList[hCount] = (vyMinus1 + vy) / 2; hCount++;		// New pixel between 2 verts
									vertexHeightList[hCount] = vy; hCount++;						// This pixel is at vertex position
								} else if (col == 8) {												// Bottom of 17x16
									vertexHeightList[hCount] = (vyMinus1 + vy) / 2; hCount++;		// New pixel between 2 verts
									// Not drawing pixel 17
								}															
							} else if (!isShort && y == 15) { 										// Long Column; INCLUDE the bottom row (17x17)
								if (col == 0) {														// Top of 17x17 subchunk heightmap
									vertexHeightList[hCount] = vy; hCount++;						// First pixel is first vertex
								} else if (col < 8) {												// Middle of column
									vertexHeightList[hCount] = (vyMinus1 + vy) / 2; hCount++;		// New pixel between 2 verts
									vertexHeightList[hCount] = vy; hCount++;						// This pixel is at vertex position
								} else if (col == 8) { 												// Bottom of 17x17
									vertexHeightList[hCount] = (vyMinus1 + vy) / 2; hCount++;		// New pixel between 2 verts
									vertexHeightList[hCount] = vy; hCount++; 						// Include bottom row of pixels
								}
							} else if (isShort && y < 15) { 										// Short Column; DO NOT draw bottom row (17x16)
								vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; hCount++;		// New pixel between 2 verts
								vertexHeightList[hCount] = vy; hCount++;
							} else if (isShort && y == 15) { 										// Short Column; Include the bottom row (17x17)
								if (col < 7) {														// Middle of column 
									vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; hCount++;	// New pixel between 2 verts
									vertexHeightList[hCount] = vy; hCount++;						// This pixel is at vertex position
								} else if (col == 7) {												// Bottom of 17x16
									vertexHeightList[hCount] = (vyMinus9 + vyPlus8) / 2; hCount++;	// New pixel between 2 verts
									vertexHeightList[hCount] = vy; hCount++;						// This pixel is at vertex position
									vertexHeightList[hCount] = (vyMinus8 + vyPlus9) / 2; hCount++;	// Include bottom row of pixels
								}
							}
						}
						//************************************************************************//
						// END Populate Height Data
						//************************************************************************//
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
						if (!(chunk.holesLowRes & current)) { isHole = false; }							
					} else {
						if (!((holesHighRes[yy] >> xx) & 1)) { isHole = false; }							
					}
					if (!isHole) {
						const indOfs = ofs + j;
						indices.push(indOfs, indOfs - 9, indOfs + 8);
						indices.push(indOfs, indOfs - 8, indOfs - 9);
						indices.push(indOfs, indOfs + 9, indOfs - 8);
						indices.push(indOfs, indOfs + 8, indOfs + 9);
					}
					if (!((j + 1) % (9 + 8))) { j += 9; }
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
		//************************************************************************//
		// Save Height Data
		//************************************************************************//
		// Determine min/max terrain height values
		//var maxHeight = (Math.max(...vertexHeightList)); var minHeight = (Math.min(...vertexHeightList));		
		// Check for values which are not numbers		
		for (var i = 0; i < 66049; i++) { if (isNaN(vertexHeightList[i])){ vertexHeightList[i] = maxHeight; } }
		var index = 0;
		var heightArray2d = [...Array(257)].map(e => Array(257));
		var heightArraySubchunk = [...Array(16)].map(e => Array(16));
		var pixelPerSubChunk = 256;
		var countpixels = 0;
		
		for (let y = 0; y < 16; y++) { 		// Subchunk Y
			for (let x = 0; x < 16; x++) { 	// Subchunk X
				var xSize = 16; 			// Number of pixels X
				var ySize = 16;				// Number of pixels Y
				if (y == 15 && x < 15) {
					ySize = 17;
					pixelPerSubChunk = 272;
					heightArraySubchunk = [...Array(16)].map(e => Array(17).fill(0));
				} else if (x == 15 && y < 15) {
					xSize = 17;
					pixelPerSubChunk = 272;
					heightArraySubchunk = [...Array(17)].map(e => Array(16).fill(0));
				} else if (x == 15 && y == 15) {
					xSize = 17;
					ySize = 17;
					pixelPerSubChunk = 289;
					heightArraySubchunk = [...Array(17)].map(e => Array(17).fill(0));
				} else {
					pixelPerSubChunk = 256;
					heightArraySubchunk = [...Array(16)].map(e => Array(16).fill(0));
				}
				
				for (let row = 0; row < ySize; row++) {
					for (let col = 0; col < xSize; col ++) {
						var pixIndex = ((row * xSize) + (col));
						var index = countpixels + pixIndex;
						var xPos = Math.floor(pixIndex / xSize);
						var yPos = pixIndex - (xPos * xSize);
						heightArraySubchunk[yPos][xPos] = vertexHeightList[index];
					}
				}
								
				for (var a=0; a < heightArraySubchunk.length; a++) {
					var xRow = heightArraySubchunk[a];
					for (var b=0; b < xRow.length; b++) {
						heightArray2d[y*16 + b][x*16 + a] = heightArraySubchunk[a][b];
					}
				}
				countpixels += pixelPerSubChunk;
			}
		}
		// I don't know why but reverse the array //for (var a=0; a < heightArray2d.length; a++) { heightArray2d[a].reverse(); }
		returnArray[6].push(heightArray2d); // Return the height array to tab-map.js
		var jsonPath = path.join(dir, 'adt_' + this.tileID + '_HeightData.json');
		returnArray[4] = jsonPath; // Return the path to the heightData.json (Not needed for 4x4)
		//try { fs.writeFileSync(jsonPath, JSON.stringify(heightArray2d)); //heightmapParsedJSON
		//	} catch (err) { log.write(err); }
		//************************************************************************//
		// END Save Height Data
		//************************************************************************//
		if (!splitTextures && quality !== -1) { mtl.addMaterial('tex_' + this.tileID, 'tex_' + this.tileID + '.png'); }
		obj.setVertArray(vertices);
		obj.setNormalArray(normals);
		obj.setUVArray(uvs);
		if (!mtl.isEmpty) { obj.setMaterialLibrary(path.basename(mtl.out)); }
		//await obj.write(config.overwriteFiles); // We are not saving OBJ or MTL files anymore.
		//await mtl.write(config.overwriteFiles); // OBJ is replaced with with heightData.json. MTL is replaced with materialData.json.

		if (quality !== 0) {
			//************************************************************************//
			// Export Splatmaps
			//************************************************************************//
			if (quality === -2) {
				const materialIDs = texAdt.diffuseTextureFileDataIDs;
				const texParams = texAdt.texParams;
				const prefix = this.tileID;

				// Export the raw diffuse textures to disk.
				const materials = new Array(materialIDs.length); // List of materials used for the full chunk
				for (let i = 0, n = materials.length; i < n; i++) {
					const diffuseFileDataID = materialIDs[i];
					const blp = new BLPFile(await core.view.casc.getFile(diffuseFileDataID));
					var newPath = path.join(dir + '../../../textures/terrain/');
					newPath = path.join(newPath, diffuseFileDataID + '.png');
					await blp.saveToFile(newPath, 'image/png', false);
					const mat = materials[i] = { id: diffuseFileDataID, scale: 1 };
					if (texParams && texParams[i]) {
						const params = texParams[i];
						mat.scale = Math.pow(2, (params.flags & 0xF0) >> 4);
					}
				}
				
				var imageCount = Math.ceil(this.materialArrayFull.length/4); // was materialIDs.length
				var pixelData = new Array(imageCount);
				for (var p = 0; p < pixelData.length; p++) {
					pixelData[p] = new Uint8ClampedArray(1024 * 1024 * 4);
				}
				// Writing a 1024x1024 image in 64x64 chunks
				var bytesPerPixel     = 4;      // Each pixel has a R,G,B,A byte
				var bytesPerColumn    = 262144; // A 'column' is 1024 pixels vertical (chunk) bytesPerRow * b
				var bytesPerRow       = 4096;   // A 'row' is 1024 pixels horizontal (chunk) a * 4
				var bytesPerSubColumn = 16384;  // A 'subcolumn' is 64 pixels vertical (subchunk) bytesPerSubRow * b
				var bytesPerSubRow    = 256;    // A 'subrow' is 64 pixels horizontal (subchunk) b * 4
				//var tga = new TGA(fs.readFileSync('./src/images/TGATemplate.tga'));

				// Populate a material list for each of the 256 subchunks
				var materialData = new Array(256);
				for (let x = 0; x < 16; x++) {		// Subchunk X
					for (let y = 0; y < 16; y++) {	// Subchunk Y
						const chunkIndex = (y * 16) + x;
						const texChunk = texAdt.texChunks[chunkIndex];
						const textureLayers = texChunk.layers;
						var matDataList = [];
						var matData = new Array(0, 0);
						if (textureLayers.length == 0) { matDataList.push(matData); }
						for (let i = 0; i < texChunk.layers.length; i++) {
							const mat = materials[texChunk.layers[i].textureId];
							matData = new Array(mat.id, mat.scale);
							matDataList.push(matData);
						}
						materialData[chunkIndex] = matDataList;
					}
				}
								
				// Now before we draw each sub-chunk to TGA, we need to check its texture list in json.
				// Based on what order the textures are for that sub-chunk, we may need to draw RGBA in a different order than 0,1,2,3
				// Loop Y first so we go left to right, top to bottom. Loop 16x16 subchunks to get the full chunk
				for (let x = 0; x < 16; x++) {
					for (let y = 0; y < 16; y++) {
						const chunkIndex = (y * 16) + x;
						const texChunk = texAdt.texChunks[chunkIndex];
						const alphaLayers = texChunk.alphaLayers || [];
						const textureLayers = texChunk.layers;

						// If there are no texture data just skip it. Todo: Draw black?
						if (textureLayers.length > 0) {
							// 1024 pixels wide, 64 pixels high = 65536 * 4 bytes = 262144 (looping y axis)
							for (let j = y * bytesPerColumn; j < (y * bytesPerColumn) + bytesPerColumn; j += bytesPerRow) {
								// Now we need to loop the x axis, 64 pixels long. 64 pixels, 4 bytes each = 256
								for (let i = x * bytesPerSubRow; i < (x * bytesPerSubRow) + bytesPerSubRow; i += bytesPerPixel) {
									var yloop = ((j / bytesPerRow) - (y * bytesPerColumn) / bytesPerRow);
									var xloop = ((i / 4) - ((x * bytesPerSubRow) / 4));
									var alphaIndex = (yloop * 64) + xloop;
									
									// this.materialArrayFull   // USE THIS FOR SPLATMAP CREATION									
									for (var k = 0; k < textureLayers.length; k++) { // Looping texture layers, could be 0-100 (61 for Stormwind)										
										var currentID =  materialData[chunkIndex][k][0];
										var currentMaterialIndex = -1;
										for (var l = 0; l < this.materialArrayFull.length; l++) {
											if (this.materialArrayFull[l] == currentID) {
												currentMaterialIndex = l;
											}
										}

										var imageIndex = Math.floor(currentMaterialIndex/4); // Calculate image index, 1 splatmap for each 4 textures.
										var channelIndex = currentMaterialIndex % 4; // 0-3 RGBA Channel of the current splatmap
										
										// 'vec3 blendTex' from the adt.fragment shader
										var blendTexs = new Array(3).fill(0);
										for (let b = 0; b < blendTexs.length; b++) {
											if (alphaLayers[b+1] === undefined){ // Plus 1 because alpha layers are 1-3
												blendTexs[b] = 0;
											}else{
												blendTexs[b] = alphaLayers[b+1][alphaIndex];
											}
										}
										
										// 'vec4 layer_weights' from the adt.fragment shader
										var sumBlendTexs = 0;
										for (let b = 0; b < blendTexs.length; b++){ sumBlendTexs += blendTexs[b]; }
										sumBlendTexs = this.Clamp(sumBlendTexs, 0, 255);
										var layerWeights = new Array(4).fill(0);
										layerWeights[0] = 255 - sumBlendTexs; 	// R
										layerWeights[1] = blendTexs[0];			// G
										layerWeights[2] = blendTexs[1];			// B
										layerWeights[3] = blendTexs[2];			// A

										// Write the actual pixel data (THIS ONLY WORKS FOR RETAIL, NOT FOR CLASSIC SPLATMAPS)
										if (k == 0) { // Base Layer
											pixelData[imageIndex][j + i + channelIndex] = layerWeights[0];
										} else {
											pixelData[imageIndex][j + i + channelIndex] = alphaLayers[k][alphaIndex]; // Maybe layerWeights[k] ?
										}
									}
								}
							}
						}
					}
				}
				log.write("Finished Splatmap Loop");
				jsonPath = path.join(dir, 'adt_' + this.tileID + '_MaterialData.json');
				returnArray[5] = jsonPath; // Send the _MaterialData.json path to tab-maps.js
				returnArray[7] = pixelData; // Send the pixelData array (subchunk splatmap) to tab-maps.js
				try { fs.writeFileSync(jsonPath, JSON.stringify(materials)); } catch (err) { console.error(err); }
				// Moved tga generation to Tab-map.js
				//************************************************************************//
				// END Export Splatmaps
				//************************************************************************//

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
							for (let j = 0; j < layer.length; j++) { imageData.data[(j * 4) + (i - 1)] = layer[j]; }
						}

						// Set all the alpha values to max.
						for (let i = 0; i < 64 * 64; i++) { imageData.data[(i * 4) + 3] = 255; }
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
						if (i > 0) { uBlends[i] = gl.getUniformLocation(glShaderProg, 'pt_blend' + i); }
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
					if (!splitTextures) { gl.uniform2f(uTranslation, -deltaX, -deltaY); }
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
							for (const tex of alphaTextures) { gl.deleteTexture(tex); }
							// Save this individual chunk.
							if (splitTextures) {
								const tilePath = path.join(dir, 'tex_' + this.tileID + '_' + (chunkID++) + '.png');
								if (config.overwriteFiles || !await generics.fileExists(tilePath)) { await saveCanvas(tilePath); }
							}
						}
					}
					// Save the completed tile.
					if (!splitTextures) { await saveCanvas(path.join(dir, 'tex_' + this.tileID + '.png')); }
					// Clear buffer.
					gl.bindBuffer(gl.ARRAY_BUFFER, null);
					// Delete loaded textures.
					for (const mat of materials) { gl.deleteTexture(mat.texture); }
				}
			}
		}

		// Export dooads / WMOs.
		if (config.mapsIncludeWMO || config.mapsIncludeM2) {
			const objectCache = new Set();
			const csvPath = path.join(dir, 'adt_' + this.tileID + '_ModelPlacementInformation.csv');
			returnArray[3] = csvPath; // Send the _ModelPlacementInfo back to tab-maps.js
			if (config.overwriteFiles || !await generics.fileExists(csvPath)) {
				const csv = new CSVWriter(csvPath);
				csv.addField('ModelFile', 'PositionX', 'PositionY', 'PositionZ', 'RotationX', 'RotationY', 'RotationZ', 'ScaleFactor', 'ModelId', 'Type');
				if (config.mapsIncludeM2) {
					//log.write('Exporting %d doodads for ADT...', objAdt.models.length);
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
					//log.write('Exporting %d WMOs for ADT...', objAdt.worldModels.length);
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
								if (config.mapsIncludeWMOSets) { wmo.setDoodadSetMask({ [model.doodadSet]: { checked: true } }); }
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
		if (config.mapsIncludeFoliage && !hasLoadedFoliage) { await loadFoliageTables(); }
		// Export foliage.
		if (config.mapsIncludeFoliage && isFoliageAvailable) {
			const foliageExportCache = new Set();
			const foliageDir = path.join(dir, 'foliage');
			//log.write('Exporting foliage to %s', foliageDir);

			for (const chunk of texAdt.texChunks) {
				// Skip chunks that have no layers?
				if (!chunk.layers) { continue; }
				for (const layer of chunk.layers) {
					// Skip layers with no effect.
					if (!layer.effectID) { continue; }
					const groundEffectTexture = dbTextures.getRow(layer.effectID);
					if (!groundEffectTexture || !Array.isArray(groundEffectTexture.DoodadID)) { continue; }
					for (const doodadEntryID of groundEffectTexture.DoodadID) {
						// Skip empty fields.
						if (!doodadEntryID) { continue; }
						const groundEffectDoodad = dbDoodads.getRow(doodadEntryID);
						if (groundEffectDoodad) {
							const modelID = groundEffectDoodad.ModelFileID;
							if (!modelID || foliageExportCache.has(modelID)) { continue; }
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
	Clamp(num, min, max) { return num <= min ? min : num >= max ? max : num; }
}
module.exports = ADTExporter4x4;