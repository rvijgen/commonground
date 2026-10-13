import { 
  BufferGeometry, 
  Float32BufferAttribute, 
  Mesh, 
  MeshBasicMaterial, 
  Scene, 
  Vector3,
  VideoTexture,
  PlaneGeometry,
  Group,
  Matrix4, 
  DoubleSide,
  Euler,
  Material} from 'three';


// videoTest.js
// This class is responsible for testing video functionalities in the WebXR application.



export default class VideoTest {
  constructor() {
    this.videoGroup = new Group()
    this.planeMaterial = null;
  }

  
  init() {
   

    const video = document.createElement('video');
    video.src = process.env.VIDEO_URL;
    video.crossOrigin = 'anonymous';
    video.loop = true;
    video.muted = true;
    video.play();

    const videoTexture = new VideoTexture(video);
    const planeGeometry = new PlaneGeometry(1, 1);
    this.planeMaterial = new MeshBasicMaterial({ map: videoTexture });
    //const videoPlane = new Mesh(planeGeometry, this.planeMaterial);
    // videoPlane.position.set(0, 0.5, 0);
    // this.videoGroup.add(videoPlane);
    // sceneGroup.add(videoPlane);
    // objects.set('videoPlane', videoPlane);
    
    // console.log('Video plane added to the scene at (0, 0, 0)');
     // Add 100 random blue planes
    // this.addRandomPlanes();
    // this.createCombinedPlanesGeometry();
    this.createEmptyPlanesGeometry()
    return this.videoGroup;
  }
  
  addRandomPlanes() {
    const planeCount = 100;
    const planeSize = 0.1;
    const gridSize = 10; // 10x10 grid
    for (let i = 0; i < planeCount; i++) {
      const geometry = new BufferGeometry();
      const half = planeSize / 2;
      const vertices = [
        -half, -half, 0,
         half, -half, 0,
         half,  half, 0,
        -half,  half, 0
      ];
      const indices = [0, 1, 2, 0, 2, 3];
      geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();

      // Calculate UVs for 0.1x0.1 segment
      const x = i % gridSize;
      const y = Math.floor(i / gridSize);
      const u0 = x * 0.1;
      const v0 = y * 0.1;
      const u1 = u0 + 0.1;
      const v1 = v0 + 0.1;
      const uvs = [
        u0, v0,
        u1, v0,
        u1, v1,
        u0, v1
      ];
      geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));

      // Random position in [-1, 1] for x, y, z
      const pos = new Vector3(
        Math.random() * 2 - 1,
        Math.random() * 2 ,
        Math.random() * 2 - 1
      );

      // Random orientation
      const mat = new Matrix4();
      mat.makeRotationFromEuler({
        x: Math.random() * Math.PI,
        y: Math.random() * Math.PI,
        z: Math.random() * Math.PI
      });
      geometry.applyMatrix4(mat);

      const mesh = new Mesh(geometry, this.planeMaterial);
      mesh.position.copy(pos);
      this.videoGroup.add(mesh);
    }
  }

  createCombinedPlanesGeometry() {
    const planeCount = 1000;
    const planeSize = 0.1;
    const gridSize = 10; // 10x10 grid
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    let vertexOffset = 0;
    const half = planeSize / 2;

    for (let i = 0; i < planeCount; i++) {
        // Plane vertices (centered at origin)
        const planeVerts = [
            -half, -half, 0,
             half, -half, 0,
             half,  half, 0,
            -half,  half, 0
        ];
        // Plane normals (all facing +Z)
        const planeNorms = [
            0, 0, 1,
            0, 0, 1,
            0, 0, 1,
            0, 0, 1
        ];
        // Calculate UVs for 0.1x0.1 segment
        // const x = i % gridSize;
        // const y = Math.floor(i / gridSize);

        const x = Math.floor(Math.random() * gridSize);
        const y = Math.floor(Math.random() * gridSize);
        const u0 = x * 0.1;
        const v0 = y * 0.1;
        const u1 = u0 + 0.1;
        const v1 = v0 + 0.1;
        const planeUVs = [
            u0, v0,
            u1, v0,
            u1, v1,
            u0, v1
        ];

        // Random position in [-1, 1] for x, y, z
        const randomOffset = [
            Math.random() * 2 - 1, // x
            Math.random() * 2 , // y
            Math.random() * 2 - 1  // z
        ];

        // Add transformed vertices, normals, and UVs
        for (let v = 0; v < 4; v++) {
            positions.push(
                planeVerts[v * 3] + randomOffset[0],
                planeVerts[v * 3 + 1] + randomOffset[1],
                planeVerts[v * 3 + 2] + randomOffset[2]
            );
            normals.push(...planeNorms.slice(v * 3, v * 3 + 3));
        }
        uvs.push(...planeUVs);

        // Indices for two triangles
        indices.push(
            vertexOffset, vertexOffset + 1, vertexOffset + 2,
            vertexOffset, vertexOffset + 2, vertexOffset + 3
        );
        vertexOffset += 4;
    }

    // Create a single BufferGeometry for all planes
    const material = this.planeMaterial;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);

    // Create a Mesh with the geometry and material, and add it to the scene
    const mesh = new Mesh(geometry, material);
    this.videoGroup.add(mesh);

    return mesh;
  }
  createEmptyPlanesGeometry() {
      const planeCount = 10000;
      const planeSize = 0.05;
      const gridSize = 10; // 10x10 grid
      const positions = [];
      const normals = [];
      const uvs = [];
      const indices = [];
      let vertexOffset = 0;
      const half = planeSize / 2;

      for (let i = 0; i < planeCount; i++) {
          // Plane vertices (centered at origin)
          const planeVerts = [
              -half, -half, 0,
              half, -half, 0,
              half,  half, 0,
              -half,  half, 0
          ];
          // Plane normals (all facing +Z)
          const planeNorms = [
              0, 0, 1,
              0, 0, 1,
              0, 0, 1,
              0, 0, 1
          ];
          // Calculate UVs for 0.1x0.1 segment
          const x = Math.floor(Math.random() * gridSize);
          const y = Math.floor(Math.random() * gridSize);
          const u0 = x * 0.1;
          const v0 = y * 0.1;
          const u1 = u0 + 0.1;
          const v1 = v0 + 0.1;
          const planeUVs = [
              u0, v0,
              u1, v0,
              u1, v1,
              u0, v1
          ];

          // Random position in [-1, 1] for x, y, z
          const randomOffset = [
              Math.random() * 4 - 2, // x
              Math.random() * 4 , // y
              Math.random() * 4 - 2  // z
          ];

          // Random rotation
          const rotationMatrix = new Matrix4();
          rotationMatrix.makeRotationFromEuler(
              new Euler(
                  Math.random() * Math.PI * 2, // Random rotation around X
                  Math.random() * Math.PI * 2, // Random rotation around Y
                  Math.random() * Math.PI * 2  // Random rotation around Z
              )
          );

          // Add transformed vertices, normals, and UVs
          for (let v = 0; v < 4; v++) {
              const vertex = new Vector3(
                  planeVerts[v * 3],
                  planeVerts[v * 3 + 1],
                  planeVerts[v * 3 + 2]
              );
              vertex.applyMatrix4(rotationMatrix);
              positions.push(
                  vertex.x + randomOffset[0],
                  vertex.y + randomOffset[1],
                  vertex.z + randomOffset[2]
              );

              const normal = new Vector3(
                  planeNorms[v * 3],
                  planeNorms[v * 3 + 1],
                  planeNorms[v * 3 + 2]
              );
              normal.applyMatrix4(rotationMatrix).normalize();
              normals.push(normal.x, normal.y, normal.z);
          }
          uvs.push(...planeUVs);

          // Indices for two triangles
          indices.push(
              vertexOffset, vertexOffset + 1, vertexOffset + 2,
              vertexOffset, vertexOffset + 2, vertexOffset + 3
          );
          vertexOffset += 4;
      }

      // Create a single BufferGeometry for all planes
      const material = new MeshBasicMaterial({ map: this.planeMaterial.map, side: DoubleSide });
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
      geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);

      // Create a Mesh with the geometry and material, and add it to the scene
      const mesh = new Mesh(geometry, material);
      this.videoGroup.add(mesh);

      return mesh;
  }
}