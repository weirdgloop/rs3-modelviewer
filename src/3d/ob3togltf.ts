import { defaultMaterial, JMat, materialCacheKey } from "./jmat";
import { Stream, packedHSL2HSL, HSL2RGB, ModelModifications } from "./utils";
import { GLTFBuilder } from "./gltf";
import { GlTf, MeshPrimitive, Material } from "./gltftype";
import { cacheMajors } from "../constants";
import { ParsedTexture } from "./textures";
import { glTypeIds, ModelAttribute, streamChunk, vartypeEnum, buildAttributeBuffer, AttributeSoure } from "./gltfutil";
import * as THREE from "three";


export type FileGetter = (major: number, minor: number) => Promise<Buffer>;


//a wrapper around gltfbuilder that ensures that resouces are correctly shared
export class GLTFSceneCache {
	getFileById: FileGetter;
	textureCache = new Map<number, number>();
	gltfMaterialCache = new Map<number, Promise<number>>();
	gltf = new GLTFBuilder();

	constructor(getfilebyid: FileGetter) {
		this.getFileById = getfilebyid;
	}

	async getTextureFile(texid: number, allowAlpha) {
		let cached = this.textureCache.get(texid);
		if (cached) { return cached; }

		let file = await this.getFileById(cacheMajors.texturesDds, texid);
		let parsed = new ParsedTexture(file, allowAlpha);
		let texnode = this.gltf.addImage(await parsed.convertFile("png"));
		this.textureCache.set(texid, texnode);
		return texnode;
	}

	async getGlTfMaterial(matid: number, hasVertexAlpha: boolean) {
		//create a seperate material if we have alpha
		//TODO the material should have this data, not the mesh
		let matcacheid = materialCacheKey(matid, hasVertexAlpha);
		let cached = this.gltfMaterialCache.get(matcacheid);
		if (!cached) {
			cached = (async () => {
				let { textures, alphamode } = await getMaterialData(this.getFileById, matid);

				let materialdef: Material = {
					//TODO check if diffuse has alpha as well
					alphaMode: hasVertexAlpha ? "BLEND" : "OPAQUE"
				}

				let sampler = this.gltf.addSampler({});//TODO wrapS wrapT from material flags

				if (textures.diffuse) {
					materialdef.pbrMetallicRoughness = {};
					//TODO animated texture UV's (fire cape)
					materialdef.pbrMetallicRoughness.baseColorTexture = {
						index: this.gltf.addTexture({ sampler, source: await this.getTextureFile(textures.diffuse, alphamode != "opaque") }),
					};
					//materialdef.pbrMetallicRoughness.baseColorFactor = [factors.color, factors.color, factors.color, 1];
					if (typeof textures.metalness != "undefined") {
						if (textures.metalness) {
							materialdef.pbrMetallicRoughness.metallicRoughnessTexture = {
								index: this.gltf.addTexture({ sampler, source: await this.getTextureFile(textures.metalness, false) })
							}
						}
						//materialdef.pbrMetallicRoughness.metallicFactor = factors.metalness;
					}
				}
				if (textures.normal) {
					materialdef.normalTexture = {
						index: this.gltf.addTexture({ sampler, source: await this.getTextureFile(textures.normal, false) })
					}
				}
				if (textures.specular) {
					//TODO not directly supported in gltf
				}
				return this.gltf.addMaterial(materialdef);
			})();
			this.gltfMaterialCache.set(matcacheid, cached);
		}
		return cached;
	}
}

export type MaterialData = {
	textures: {
		diffuse?: number,
		specular?: number,
		metalness?: number,
		color?: number,
		normal?: number,
		compound?: number
	},
	alphamode: "opaque" | "cutoff" | "blend"
	raw: any
}
//this one is narly, i have touched it as little as possible, needs a complete refactor together with JMat
export async function getMaterialData(getFile: FileGetter, matid: number) {
	if (matid == -1) {
		return defaultMaterial();
	}
	var materialfile = await getFile(cacheMajors.materials, matid);
	return JMat(materialfile);
}

//TODO remove or rewrite
export async function ob3ModelToGltfFile(getFile: FileGetter, model: Buffer, mods: ModelModifications) {
	// let scene = new GLTFSceneCache(getFile);
	// let stream = new Stream(model);
	// let mesh = await addOb3Model(scene, parseOb3Model(stream, mods));
	// //flip z to go from right-handed to left handed
	// let rootnode = scene.gltf.addNode({ mesh: mesh, scale: [1, 1, -1] });
	// scene.gltf.addScene({ nodes: [rootnode] });
	// let result = await scene.gltf.convert({ singlefile: true, glb: false });
	// console.log("gltf", scene.gltf.json);
	// return result.mainfile;
}

export type ModelData = {
	maxy: number,
	miny: number,
	bonecount: number,
	meshes: ModelMeshData[]
}

export type ModelMeshData = {
	indices: THREE.BufferAttribute,
	materialId: number,
	hasVertexAlpha: boolean,
	attributes: {
		pos: THREE.BufferAttribute,
		normals?: THREE.BufferAttribute,
		color?: THREE.BufferAttribute,
		texuvs?: THREE.BufferAttribute,
		skinids?: THREE.BufferAttribute,
		skinweights?: THREE.BufferAttribute
	}
}

export function parseOb3Model(modelfile: Buffer) {
	let model: Stream = new Stream(modelfile);
	let format = model.readByte();
	let unk1 = model.readByte(); //always 03?
	let version = model.readByte();
	let meshCount = model.readUByte();
	let unkCount0 = model.readUByte();
	let unkCount1 = model.readUByte();
	let unkCount2 = model.readUByte();
	let unkCount3 = model.readUByte();
	// console.log("model unks", unk1, unkCount0, unkCount1, unkCount2, unkCount3);

	let maxy = 0;
	let miny = 0;
	let bonecount = 0;
	let meshes: ModelMeshData[] = [];

	for (var n = 0; n < meshCount; ++n) {
		// Flag 0x10 is currently used, but doesn't appear to change the structure or data in any way
		let groupFlags =model.readUInt();

		// Unknown, probably pertains to materials transparency maybe?
		let unk6 = model.readUByte();
		let materialArgument = model.readUShort();
		let faceCount = model.readUShort();

		let materialId = materialArgument - 1;

		let hasVertices = (groupFlags & 0x01) != 0;
		let hasVertexAlpha = (groupFlags & 0x02) != 0;
		let hasFaceBones = (groupFlags & 0x04) != 0;
		let hasBoneids = (groupFlags & 0x08) != 0;
		let isHidden = (groupFlags & 0x10) != 0;
		let hasFlag20 = (groupFlags & 0x20) != 0;
		// console.log(n, "mat", materialId, "faceCount", faceCount, "hasFaceBones:", hasFaceBones, "ishidden:", isHidden, "hasflag20:", hasFlag20, "unk6:", unk6);
		if (groupFlags & ~0x2f) {
			console.log("unknown model flags", groupFlags & ~0x2f);
		}

		let colourBuffer: Uint8Array | null = null;
		let alphaBuffer: Uint8Array | null = null;
		let positionBuffer: ArrayLike<number> | null = null;
		let normalBuffer: ArrayLike<number> | null = null;
		let uvBuffer: Float32Array | null = null;
		let boneidBuffer: Uint16Array | null = null;
		let faceboneidBuffer: Uint16Array | null = null;

		if (hasVertices) {
			colourBuffer = new Uint8Array(faceCount * 3);
			for (var i = 0; i < faceCount; ++i) {
				var faceColour = model.readUShort();
				var colour = HSL2RGB(packedHSL2HSL(faceColour));
				colourBuffer[i * 3 + 0] = colour[0];
				colourBuffer[i * 3 + 1] = colour[1];
				colourBuffer[i * 3 + 2] = colour[2];
			}
		}
		if (hasVertexAlpha) {
			alphaBuffer = streamChunk(Uint8Array, model, faceCount);
		}

		//bone ids per face, face/vertex color related?
		if (hasFaceBones) {
			faceboneidBuffer = streamChunk(Uint16Array, model, faceCount);
		}

		let indexBufferCount = model.readUByte();
		let indexBuffers: Uint16Array[] = [];
		for (var i = 0; i < indexBufferCount; ++i) {
			var indexCount = model.readUShort();
			indexBuffers.push(streamChunk(Uint16Array, model, indexCount));
		}

		//not sure what happens without these flags
		let vertexCount = 0;
		if (hasVertices || hasBoneids) {
			vertexCount = model.readUShort();
			if (hasVertices) {
				positionBuffer = streamChunk(Int16Array, model, vertexCount * 3);
				normalBuffer = streamChunk(Int8Array, model, vertexCount * 3);
				//not currently used
				let tangentBuffer = streamChunk(Int8Array, model, vertexCount * 4);
				uvBuffer = new Float32Array(vertexCount * 2);
				for (let i = 0; i < vertexCount * 2; i++) {
					uvBuffer[i] = model.readHalf();
				}
				//group.uvBuffer = streamChunk(Uint16Array, model, group.vertexCount * 2);
			}
			if (hasBoneids) {
				//TODO there can't be more than ~50 bones in the engine, what happens to the extra byte?
				boneidBuffer = streamChunk(Uint16Array, model, vertexCount);
			}
		}
		if (hasFlag20) {
			//probably material related
			//models from this update/area also for the first time has some sort of "skybox" material
			//
			let count = model.readUInt();
			let bytes = streamChunk(Uint8Array, model, count * 3);
			console.log("mesh flag20", bytes);
			let a = 1;
		}

		if (isHidden) {
			console.log("skipped mesh with 0x10 flag");
			continue;
		}

		if (!positionBuffer) {
			console.log("skipped mesh without position buffer")
			continue;
		}

		// if (faceboneidBuffer) {
		// 	console.log("faceboneidBuffer", faceboneidBuffer);
		// }

		//TODO somehow this doesn't always work
		if (materialId != -1) {
			// let replacedmaterial = modifications.replaceMaterials?.find(q => q[0] == materialId)?.[1];
			// if (typeof replacedmaterial != "undefined") {
			// 	materialId = replacedmaterial;
			// }
		}
		//TODO let threejs do this while making the bounding box
		for (let i = 0; i < positionBuffer.length; i += 3) {
			if (positionBuffer[i + 1] > maxy) {
				maxy = positionBuffer[i + 1];
			}
			if (positionBuffer[i + 1] < miny) {
				miny = positionBuffer[i + 1];
			}
		}
		// let positionfloatbuffer = new Float32Array(positionBuffer);


		//highest level of detail only
		let indexbuf = indexBuffers[0];

		let meshdata: ModelMeshData = {
			indices: new THREE.BufferAttribute(indexbuf, 1),
			materialId,
			hasVertexAlpha,
			attributes: {
				pos: new THREE.BufferAttribute(new Float32Array(positionBuffer), 3)
			}
		};
		meshes.push(meshdata);

		if (boneidBuffer) {
			//every modern animation system uses 4 skinned bones per vertex instead of one
			let quadboneids = new Uint8Array(boneidBuffer.length * 4);
			let quadboneweights = new Uint8Array(boneidBuffer.length * 4);
			const maxshort = (1 << 16) - 1;
			for (let i = 0; i < boneidBuffer.length; i++) {
				let id = boneidBuffer[i]
				id = (id == maxshort ? 0 : id + 1);
				quadboneids[i * 4] = id;
				quadboneweights[i * 4] = 255;
				if (id >= bonecount) {
					bonecount = id + 1;
				}
			}
			meshdata.attributes.skinids = new THREE.BufferAttribute(quadboneids, 4);
			meshdata.attributes.skinweights = new THREE.BufferAttribute(quadboneweights, 4, true);
		}

		if (uvBuffer) {
			meshdata.attributes.texuvs = new THREE.BufferAttribute(uvBuffer, 2);
		}

		if (normalBuffer) {
			let normalsrepacked = new Float32Array(normalBuffer.length);
			//TODO threejs can probly do this for us
			for (let i = 0; i < normalBuffer.length; i += 3) {
				let x = normalBuffer[i + 0];
				let y = normalBuffer[i + 1];
				let z = normalBuffer[i + 2];
				//recalc instead of taking 255 because apparently its not normalized properly
				let len = Math.hypot(x, y, z);
				normalsrepacked[i + 0] = x / len;
				normalsrepacked[i + 1] = y / len;
				normalsrepacked[i + 2] = z / len;
			}
			meshdata.attributes.normals = new THREE.BufferAttribute(normalsrepacked, 3);// { newtype: "f32", vecsize: 3, source: normalsrepacked };
		}

		//convert per-face attributes to per-vertex
		if (colourBuffer) {
			let vertexcolor = new Uint8Array(vertexCount * 4);
			meshdata.attributes.color = new THREE.BufferAttribute(vertexcolor, 4, true);
			for (let i = 0; i < faceCount; i++) {
				//iterate triangle vertices
				for (let j = 0; j < 3; j++) {
					let index = indexbuf[i * 3 + j] * 4;
					vertexcolor[index + 0] = colourBuffer[i * 3 + 0];
					vertexcolor[index + 1] = colourBuffer[i * 3 + 1];
					vertexcolor[index + 2] = colourBuffer[i * 3 + 2];
					if (alphaBuffer) {
						vertexcolor[index + 3] = alphaBuffer[i];
					} else {
						vertexcolor[index + 3] = 255;
					}
				}
			}

		}
		// // TODO proper toggle for this or remove
		// // visualize bone ids
		// materialArgument = 0;
		// let vertexcolor = new Uint8Array(vertexCount * 4);
		// meshdata.attributes.color = new THREE.BufferAttribute(vertexcolor, 4, true);
		// let allbones = new Set<number>();
		// const bonecols = [
		// 	[255, 255, 255],//0 white no bone
		// 	[255, 0, 0],//1 red
		// 	[0, 255, 0],//2 green
		// 	[0, 0, 255],//3 blue
		// 	[90, 0, 0],//4 red--
		// 	[0, 90, 0],//5 green--
		// 	[0, 0, 90],//6 blue--
		// 	[255, 255, 0],//7 yellow
		// 	[0, 255, 255],//8 cyan
		// 	[255, 0, 255],//9 purple
		// ]
		// for (let i = 0; i < vertexCount; i++) {
		// 	let index = i * 4;
		// 	let boneid = meshdata.attributes.skinids?.array[index]!;
		// 	// let boneid = n;
		// 	vertexcolor[index + 0] = (boneid < bonecols.length ? bonecols[boneid][0] : (73 + boneid * 9323) % 256);
		// 	vertexcolor[index + 1] = (boneid < bonecols.length ? bonecols[boneid][1] : (171 + boneid * 1071) % 256);
		// 	vertexcolor[index + 2] = (boneid < bonecols.length ? bonecols[boneid][2] : (23 + boneid * 98537) % 256);
		// 	vertexcolor[index + 3] = 255;
		// 	allbones.add(boneid);
		// }
	}
	for (let n = 0; n < unkCount1; n++) {
		model.skip(37);
	}
	for (let n = 0; n < unkCount2; n++) {
		model.skip(2);//material id?
		for (let i = 0; i < 3; i++) {
			model.skip(2); model.skip(2);//u16 flags mostly 0x0000,0x0040,0x0080, f16 position? mostly -5.0<x<5.0
			model.skip(2); model.skip(2);//u16 flags, f16?
			model.skip(2); model.skip(2);//u16 flags, f16?
			model.skip(2);//i16, mostly -1, otherwise <400
		}
	}
	for (let n = 0; n < unkCount3; n++) {
		model.skip(16);
	}


	let r: ModelData = { maxy, miny, meshes, bonecount };

	if (model.scanloc() != model.getData().length) {
		console.log("extra model bytes", model.getData().length - model.scanloc(), "format", format, "unk1", unk1, "version", version, "unkcounts", unkCount0, unkCount1, unkCount2, unkCount3);
		// fs.writeFileSync(`cache/particles/${Date.now()}.bin`, model.getData().slice(model.scanloc()));
	}
	return r;
}
