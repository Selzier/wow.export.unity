/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */
const path = require('path');
const constants = require('../../constants');
const generics = require('../../generics');
const FileWriter = require('../../file-writer');

class OBJWriter {
	/**
	 * Construct a new OBJWriter instance.
	 * @param {string} out Output path to write to.
	 */
	constructor(out) {
		this.out = out;

		this.verts = [];
		this.normals = [];
		this.uvs = [];

		this.meshes = [];
		this.name = 'Mesh';
	}
	
	/**
	 * Set the name of the material library.
	 * @param {string} name 
	 */
	setMaterialLibrary(name) {
		this.mtl = name;
	}

	/**
	 * Set the name of this model.
	 * @param {string} name 
	 */
	setName(name) {
		this.name = name;
	}

	/**
	 * Set the vertex array for this writer.
	 * @param {Array} verts 
	 */
	setVertArray(verts) {
		this.verts = verts;
	}

	/**
	 * Set the normals array for this writer.
	 * @param {Array} normals 
	 */
	setNormalArray(normals) {
		this.normals = normals;
	}

	/**
	 * Set the UV array for this writer.
	 * @param {Array} uvs 
	 */
	setUVArray(uvs) {
		this.uvs = uvs;
	}

	/**
	 * Add a mesh to this writer.
	 * @param {string} name
	 * @param {Array} triangles 
	 * @param {string} matName
	 */
	addMesh(name, triangles, matName) {
		this.meshes.push({ name, triangles, matName });
	}

	/**
	 * Write the OBJ file (and associated MTLs).
	 * @param {boolean} overwrite
	 */
	async write(overwrite = true) {
		// If overwriting is disabled, check file existence.
		if (!overwrite && await generics.fileExists(this.out))
			return;

		await generics.createDirectory(path.dirname(this.out));
		const writer = new FileWriter(this.out);

		// Write header.
		writer.writeLine('# Exported using wow.export v' + constants.VERSION);
		writer.writeLine('o ' + this.name);

		// Link material library.
		if (this.mtl)
			writer.writeLine('mtllib ' + this.mtl);

		// Write verts.
		const verts = this.verts;
		for (let i = 0, n = verts.length; i < n; i+= 3)
			writer.writeLine('v ' + verts[i] + ' ' + verts[i + 1] + ' ' + verts[i + 2]);

		// Write normals.
		const normals = this.normals;
		for (let i = 0, n = normals.length; i < n; i += 3)
			writer.writeLine('vn ' + normals[i] + ' ' + normals[i + 1] + ' ' + normals[i + 2]);

		// Write UVs
		const uvs = this.uvs;
		for (let i = 0, n = uvs.length; i < n; i += 2)
			writer.writeLine('vt ' + uvs[i] + ' ' + uvs[i + 1]);

		// Write meshes.
		for (const mesh of this.meshes) {
			writer.writeLine('g ' + mesh.name);
			writer.writeLine('s 1');

			if (mesh.matName)
				writer.writeLine('usemtl ' + mesh.matName);

			const triangles = mesh.triangles;
			for (let i = 0, n = triangles.length; i < n; i += 3) {
				const pointA = (triangles[i] + 1) + '/' + (triangles[i] + 1) + '/' + (triangles[i] + 1);
				const pointB = (triangles[i + 1] + 1) + '/' + (triangles[i + 1] + 1) + '/' + (triangles[i + 1] + 1);
				const pointC = (triangles[i + 2] + 1) + '/' + (triangles[i + 2] + 1) + '/' + (triangles[i + 2] + 1);

				writer.writeLine('f ' + pointA + ' ' + pointB + ' ' + pointC);
			}
		}

		await writer.close();
	}
}

module.exports = OBJWriter;