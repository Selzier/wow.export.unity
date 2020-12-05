/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */
const util = require('util');
const core = require('../core');
const log = require('../log');
const path = require('path');
const listfile = require('../casc/listfile');
const constants = require('../constants');
const fs = require('fs');
const TGA = require('../2D/tga');
const WDCReader = require('../db/WDCReader');
const DB_Map = require('../db/schema/Map');

const BLPFile = require('../casc/blp');
const WDTLoader = require('../3D/loaders/WDTLoader');
const ADTLoader = require('../3D/loaders/ADTLoader');
const ADTExporter = require('../3D/exporters/ADTExporter');
const ADTExporter4x4 = require('../3D/exporters/ADTExporter4x4');
const ExportHelper = require('../casc/export-helper');
const WMOExporter = require('../3D/exporters/WMOExporter');

const MAP_SIZE = constants.GAME.MAP_SIZE;
const TILE_SIZE = constants.GAME.TILE_SIZE;
const CHUNK_SIZE = TILE_SIZE / 16;
const UNIT_SIZE = CHUNK_SIZE / 8;
const UNIT_SIZE_HALF = UNIT_SIZE / 2;
const wdtCache = new Map();

let selectedMapID;
let selectedMapDir;
let selectedWDT;

/**
 * Load a map into the map viewer.
 * @param {number} mapID 
 * @param {string} mapDir 
 */
const loadMap = async (mapID, mapDir) => {
	selectedMapID = mapID;
	selectedMapDir = mapDir;

	selectedWDT = null;
	core.view.mapViewerHasWorldModel = false;

	// Attempt to load the WDT for this map for chunk masking.
	const wdtPath = util.format('world/maps/%s/%s.wdt', mapDir, mapDir);
	log.write('Loading map preview for %s (%d)', mapDir, mapID);

	try {
		const data = await core.view.casc.getFileByName(wdtPath);
		const wdt = selectedWDT = new WDTLoader(data);
		wdt.load();

		// Enable the 'Export Global WMO' button if available.
		if (wdt.worldModelPlacement)
			core.view.mapViewerHasWorldModel = true;

		core.view.mapViewerChunkMask = wdt.tiles;
	} catch (e) {
		// Unable to load WDT, default to all chunks enabled.
		log.write('Cannot load %s, defaulting to all chunks enabled', wdtPath);
		core.view.mapViewerChunkMask = null;
	}

	// Reset the tile selection.
	core.view.mapViewerSelection.splice(0);

	// While not used directly by the components, we update this reactive value
	// so that the components know a new map has been selected, and to request tiles.
	core.view.mapViewerSelectedMap = mapID;
};

/**
 * Load a map tile.
 * @param {number} x 
 * @param {number} y 
 * @param {number} size 
 */
const loadMapTile = async (x, y, size) => {
	// If no map has been selected, abort.
	if (!selectedMapDir)
		return false;

	try {
		// Attempt to load the requested tile from CASC.
		const tilePath = util.format('world/minimaps/%s/map%d_%d.blp', selectedMapDir, x, y);
		const data = await core.view.casc.getFileByName(tilePath, false, true);
		const blp = new BLPFile(data);

		// Draw the BLP onto a raw-sized canvas.
		const canvas = blp.toCanvas(false);

		// Scale the image down by copying the raw canvas onto a
		// scaled canvas, and then returning the scaled image data.
		const scale = size / blp.scaledWidth;
		const scaled = document.createElement('canvas');
		scaled.width = size;
		scaled.height = size;

		const ctx = scaled.getContext('2d');
		ctx.scale(scale, scale);
		ctx.drawImage(canvas, 0, 0);
		
		return ctx.getImageData(0, 0, size, size);
	} catch (e) {
		// Map tile does not exist or cannot be read.
		return false;
	}
};

const exportSelectedMapWMO = async () => {
	const helper = new ExportHelper(1, 'WMO');
	helper.start();

	try {
		if (!selectedWDT || !selectedWDT.worldModelPlacement)
			throw new Error('Map does not contain a world model.');

		const placement = selectedWDT.worldModelPlacement;
		let fileDataID = 0;
		let fileName;

		if (selectedWDT.worldModel) {
			fileName = selectedWDT.worldModel;
			fileDataID = listfile.getByFilename(fileName);

			if (!fileDataID)
				throw new Error('Invalid world model path: ' + fileName);
		} else {
			if (placement.id === 0)
				throw new Error('Map does not define a valid world model.');
			
			fileDataID = placement.id;
			fileName = listfile.getByID(fileDataID) || 'unknown_' + fileDataID + '.wmo';
		}

		const exportPath = ExportHelper.replaceExtension(ExportHelper.getExportPath(fileName), '.obj');

		const data = await core.view.casc.getFile(fileDataID);
		const wmo = new WMOExporter(data, fileDataID);

		wmo.setDoodadSetMask({ [placement.doodadSetIndex]: { checked: true } });
		await wmo.exportAsOBJ(exportPath);

		helper.mark(fileName, true);
	} catch (e) {
		helper.mark('world model', false, e.message);
	}

	helper.finish();
};

const exportSelectedMap = async () => {
	const exportTiles = core.view.mapViewerSelection;
	const exportQuality = core.view.config.exportMapQuality;
	const config = core.view.config;

	// User has not selected any tiles.
	if (exportTiles.length === 0)
		return core.setToast('error', 'You haven\'t selected any tiles; hold shift and click on a map tile to select it.');

	if (config.export4x4area && exportTiles.length != 16){
		return core.setToast('error', 'You have selected 4x4 export but do not have 16 chunks selected.');
	}		

	const helper = new ExportHelper(exportTiles.length, 'tile');
	helper.start();

	const dir = ExportHelper.getExportPath(path.join('maps', selectedMapDir));
	const markPath = path.join('maps', selectedMapDir, selectedMapDir);

	exportTiles.sort(function(a, b){return a-b});

	var materialArrayFull = [];	
	var pixelDataFull;
	var tileID;

	if (config.export4x4area) {
		//************** Pre-Loop all chunks to create a terrain texture list ****/
		// This allows all 16 chunks to use a "master texture list" which will
		// become the terrain "palette preset" in the Unity terrain inspector. 
		for (const index of exportTiles) { 
			const casc = core.view.casc;
			var tileX = index % MAP_SIZE;
			var tileY = Math.floor(index / MAP_SIZE);
			tileID = tileY + '_' + tileX;
			const prefix = util.format('world/maps/%s/%s', selectedMapDir, selectedMapDir);

			let wdt = wdtCache.get(selectedMapDir);
			if (!wdt) {
				wdt = new WDTLoader(await casc.getFileByName(prefix + '.wdt'));
				await wdt.load();
				wdtCache.set(selectedMapDir, wdt);
			}	
			
			const tilePrefix = prefix + '_' + tileID;
			const maid = wdt.entries[index];
			const tex0FileDataID = maid.tex0ADT > 0 ? maid.tex0ADT : listfile.getByFilename(tilePrefix + '_obj0.adt');
			const texAdt = new ADTLoader(await casc.getFile(tex0FileDataID));
			texAdt.loadTex(wdt);
			
			const materialIDs = texAdt.diffuseTextureFileDataIDs;		
			
			if (materialIDs.length == 0){
				//fullJSON += '"id0":"null",';
			}else{
				for (let q=0; q < materialIDs.length; q++){				
					if (materialArrayFull.indexOf(materialIDs[q]) === -1) { materialArrayFull.push(materialIDs[q]); } // If doesn't exist, add material ID to array 				
				}
			}		
		}

		var imageCount = Math.ceil(materialArrayFull.length/4);
		log.write("Splatmap imageCount: " + imageCount);
		pixelDataFull = new Array(imageCount);
		for (var p = 0; p < pixelDataFull.length; p++){
			pixelDataFull[p] = new Uint8ClampedArray(4096 * 4096 * 4);				
		}
				
	}
	var tga = new TGA(fs.readFileSync('./src/images/TGATemplate4096.tga'));
	var heightArrayFull = [...Array(1025)].map(e => Array(1025));
	var exportSessionData = [];
	var xOffset, yOffset = 0;

	var loopIndex = 0;
	for (const index of exportTiles) {
		var tileX = index % MAP_SIZE;
		var tileY = Math.floor(index / MAP_SIZE);
		tileID = tileY + '_' + tileX;
		var adt = null;
		core.setToast('progress', 'Exporting: ' + loopIndex, null, -1, false);
		if (config.export4x4area){			
			adt = new ADTExporter4x4(selectedMapID, selectedMapDir, index, materialArrayFull); // Will need to pass the material list for all chunks.
		}else{
			adt = new ADTExporter(selectedMapID, selectedMapDir, index);
		}
		
		try {
			exportSessionData.push(await adt.export(dir, exportQuality));
			helper.mark(markPath, true);
		} catch (e) {
			helper.mark(markPath, false, e.message);
		}
		
		if (config.export4x4area) {
			xOffset = Math.floor(loopIndex / 4) * 255;
			yOffset = (loopIndex % 4) * 255;
			heightArrayFull = InsertArray(heightArrayFull, exportSessionData[loopIndex][6][0], xOffset, yOffset);
						
			var pixelData = exportSessionData[loopIndex][7];
			
			//exportSessionData[loopIndex].pop();

			/* *******************************************************************************************************
			pixelDataFull is a 1D array of 4096 values (4096*4096*4)
			pixelData is a 1D array of 1024 values (1024*1024*4)
			I'll use 4 **** to represent the 1024 values and 16 **************** to represent the 4096 values

			pixelDataFull: 
			0    1    2    3      < index
			**** **** **** ****
			**** **** **** ****
			**** **** **** ****
			**** **** **** ****

			pixelData must be put into slot 0. In this case, every (1024*4) values must be stacked vertically 1024 times
			******************************************************************************************************* */			
			if (pixelDataFull.length != pixelData.length){log.write("ERROR: pixelDataFull and pixelData lengths do not match.");}
			
			// Just fix the order
			var fixedLoopIndex = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
			for (var p = 0; p < pixelDataFull.length; p++){ // Which splatmap image
				for (var i = 0; i < 1024; i++) {   // 1024 vertical loops Splatmap Y				
					for (var j = 0; j < 4096; j++) { // 1024 pixels horizontal with 4 bytes each, Splatmap X									
						pixelDataFull[p][(Math.floor(fixedLoopIndex[loopIndex]/4) * (1024 * 16384)) + (((fixedLoopIndex[loopIndex]%4) * 4096) + j) + (i * 16384)] = pixelData[p][(i * 4096) + j]; // (i * 4096) + j == 0 - 4,194,304					
					}
				}
			}
		}
		loopIndex++;
	}

	// I don't know why but reverse the array
	heightArrayFull.reverse();

	var jsonDir = dir + "_ExportData.json";
	if (!config.export4x4area){
		try { fs.writeFileSync(jsonDir, JSON.stringify(exportSessionData)); } catch (err) { log.write(err); } // Writing way too much data
	}
	
	// exportSessionData: Array returned by ADTExporter
	// materialArrayFull: List of all materials used 
	// heightArrayFull:   Array of 1025x1025 height values
	
	if (config.export4x4area) {
		jsonDir = dir + "_MaterialData.json";
		try { fs.writeFileSync(jsonDir, JSON.stringify(materialArrayFull)); //exportSessionData //heightArrayFull
		} catch (err) { log.write(err); }
		
		jsonDir = dir + "_HeightData.json";
		try { fs.writeFileSync(jsonDir, JSON.stringify(heightArrayFull)); //exportSessionData //heightArrayFull
		} catch (err) { log.write(err); }

		var tgaPath = path.join(dir + '../../../splatmaps/');
		for (var t = 0; t < pixelDataFull.length; t++) { // Looping all splatmap images (1 per 4 textures)
			var myPath = path.join(tgaPath, 'splatmap_' + selectedMapDir + "_" + tileID + '_' + t.toString() + '.tga');
			
			tga.pixels = pixelDataFull[t]; 

			var buftga = TGA.createTgaBuffer(tga.width, tga.height, tga.pixels);
			fs.writeFileSync(myPath, buftga);
		}
	}

	// Clear the internal ADTLoader cache.
	ADTExporter.clearCache();
	helper.finish();
};

function InsertArray(big, small, x, y) {
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
};

/**
 * Parse a map entry from the listbox.
 * @param {string} entry 
 */
const parseMapEntry = (entry) => {
	const match = entry.match(/\[(\d+)\]\31([^\31]+)\31\(([^)]+)\)/);
	if (!match)
		throw new Error('Unexpected map entry');

	return { id: parseInt(match[1]), name: match[2], dir: match[3].toLowerCase() };
};

// The first time the user opens up the map tab, initialize map names.
core.events.once('screen-tab-maps', async () => {
	core.view.isBusy++;
	core.setToast('progress', 'Checking for available maps, hold on...', null, -1, false);

	const table = new WDCReader('DBFilesClient/Map.db2', DB_Map);
	await table.parse();

	const maps = [];
	for (const [id, entry] of table.getAllRows()) {
		const wdtPath = util.format('world/maps/%s/%s.wdt', entry.Directory, entry.Directory);
		if (listfile.getByFilename(wdtPath))
			maps.push(util.format('[%d]\x19%s\x19(%s)', id, entry.MapName, entry.Directory));
	}

	core.view.mapViewerMaps = maps;
	
	core.hideToast();
	core.view.isBusy--;
});

core.registerLoadFunc(async () => {
	// Store a reference to loadMapTile for the map viewer component.
	core.view.mapViewerTileLoader = loadMapTile;

	// Track selection changes on the map listbox and select that map.
	core.view.$watch('selectionMaps', async selection => {
		// Check if the first file in the selection is "new".
		const first = selection[0];

		if (!core.view.isBusy && first) {
			const map = parseMapEntry(first);
			if (selectedMapID !== map.id)
				loadMap(map.id, map.dir);
		}
	});

	// Track when user clicks to export a map or world model.
	core.events.on('click-export-map', () => exportSelectedMap());
	core.events.on('click-export-map-wmo', () => exportSelectedMapWMO());
});