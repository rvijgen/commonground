import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, MeshBasicMaterial, Mesh, Object3D } from 'three';

export class MeshFunctions {
    constructor(serverEndpoint = null) {
        // Use a relative URL so requests always use the same protocol/host/port as the page
        this.serverEndpoint = serverEndpoint || '/api/mesh';
    }

    async exportRoomMesh(ratk) {
        const roomMeshData = {
            timestamp: Date.now(),
            planes: [],
            meshes: []
        };

        // Export planes
        ratk.planes.forEach((plane) => {
            if (plane.planeMesh && plane.planeMesh.geometry) {
                // Get the final world-transformed geometry
                const mesh = plane.planeMesh;
                mesh.updateMatrixWorld(); // Ensure world matrix is up to date
                
                // Clone geometry and apply world transform
                const worldGeometry = mesh.geometry.clone();
                worldGeometry.applyMatrix4(mesh.matrixWorld);
                
                roomMeshData.planes.push({
                    id: plane.id || this.generateId(),
                    vertices: Array.from(worldGeometry.attributes.position.array),
                    indices: worldGeometry.index ? Array.from(worldGeometry.index.array) : null,
                    normal: worldGeometry.attributes.normal ? Array.from(worldGeometry.attributes.normal.array) : null,
                    semanticLabel: plane.semanticLabel || 'plane'
                    // No transform matrix needed - geometry is already in world coordinates
                });
                
                worldGeometry.dispose(); // Clean up the cloned geometry
            }
        });

        // Export meshes
        ratk.meshes.forEach((mesh) => {
            if (mesh.meshMesh && mesh.meshMesh.geometry) {
                // Get the final world-transformed geometry
                const meshMesh = mesh.meshMesh;
                meshMesh.updateMatrixWorld(); // Ensure world matrix is up to date
                
                // Clone geometry and apply world transform
                const worldGeometry = meshMesh.geometry.clone();
                worldGeometry.applyMatrix4(meshMesh.matrixWorld);
                
                roomMeshData.meshes.push({
                    id: mesh.id || this.generateId(),
                    vertices: Array.from(worldGeometry.attributes.position.array),
                    indices: worldGeometry.index ? Array.from(worldGeometry.index.array) : null,
                    normal: worldGeometry.attributes.normal ? Array.from(worldGeometry.attributes.normal.array) : null,
                    semanticLabel: mesh.semanticLabel || 'unknown'
                    // No transform matrix needed - geometry is already in world coordinates
                });
                
                worldGeometry.dispose(); // Clean up the cloned geometry
            }
        });

        //console.log('Exporting room mesh data:', roomMeshData);

        try {
            const response = await fetch(this.serverEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(roomMeshData)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            //console.log('Room mesh exported successfully:', result);
            return result;
        } catch (error) {
            if (error.message.includes('certificate') || error.message.includes('SSL') || error.name === 'TypeError') {
                console.error('Certificate error - you may need to accept the self-signed certificate first.');
                console.error(`Visit ${this.serverEndpoint} in your browser and accept the certificate.`);
            }
            console.error('Failed to export room mesh to server:', error);
            throw error; // Re-throw the error instead of falling back to localStorage
        }
    }

    async importRoomMesh() {
        try {
            const response = await fetch(this.serverEndpoint);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error('Failed to import room mesh from server:', error);
            throw error;
        }
    }

    createGeometriesFromData(roomMeshData) {
        const geometries = { planes: [], meshes: [] };

        roomMeshData.planes.forEach((planeData) => {
            const geometry = new BufferGeometry();
            geometry.setAttribute('position', new Float32BufferAttribute(planeData.vertices, 3));
            if (planeData.indices) {
                geometry.setIndex(new Uint32BufferAttribute(planeData.indices, 1));
            }
            if (planeData.normal) {
                geometry.setAttribute('normal', new Float32BufferAttribute(planeData.normal, 3));
            }
            geometries.planes.push({
                geometry,
                transform: planeData.transform,
                semanticLabel: planeData.semanticLabel,
                id: planeData.id,
                vertices: planeData.vertices, // Preserve original vertex data
                indices: planeData.indices,   // Preserve original index data
                normal: planeData.normal      // Preserve original normal data
            });
        });

        roomMeshData.meshes.forEach((meshData) => {
            const geometry = new BufferGeometry();
            geometry.setAttribute('position', new Float32BufferAttribute(meshData.vertices, 3));
            if (meshData.indices) {
                geometry.setIndex(new Uint32BufferAttribute(meshData.indices, 1));
            }
            if (meshData.normal) {
                geometry.setAttribute('normal', new Float32BufferAttribute(meshData.normal, 3));
            }

            geometries.meshes.push({
                geometry,
                transform: meshData.transform,
                semanticLabel: meshData.semanticLabel,
                id: meshData.id,
                vertices: meshData.vertices, // Preserve original vertex data
                indices: meshData.indices,   // Preserve original index data
                normal: meshData.normal      // Preserve original normal data
            });
        });

        return geometries;
    }

    /**
     * Load room mesh data for desktop viewing
     */
    async loadRoomMeshForDesktop() {
        try {
            //console.log('Loading room mesh for desktop viewing...');
            const roomMeshData = await this.importRoomMesh();
            //console.log('Raw room mesh data:', roomMeshData);
            
            const geometries = this.createGeometriesFromData(roomMeshData);
            //console.log('Created geometries:', geometries);
            //console.log('Number of planes:', geometries.planes.length);
            //console.log('Number of meshes:', geometries.meshes.length);
            
            return geometries;
        } catch (error) {
            //console.log('No room mesh data available for desktop viewing:', error);
            throw error;
        }
    }

    /**
     * Add room mesh geometries to the scene
     */
    addRoomMeshToScene(geometries, scene, roomMeshVisible = true, isDesktopMode = true) {
        //console.log('addRoomMeshToScene called with:', geometries);
        //console.log('Scene object:', scene);
        //console.log('Current scene children count:', scene.children.length);
        
        // Create a single parent group for all room mesh objects
        const roomMeshGroup = new Object3D();
        
        // Add planes
        geometries.planes.forEach((planeData, index) => {
            //console.log(`Processing plane ${index}:`, planeData);
            
            const material = new MeshBasicMaterial({
                wireframe: true,
                color: Math.random() * 0xffffff,
            });
            
            // Create mesh using the geometry (already in world coordinates)
            const mesh = new Mesh(planeData.geometry, material);
            
            // No transformations needed - geometry is already positioned correctly
            mesh.visible = roomMeshVisible;
            mesh.userData.semanticLabel = planeData.semanticLabel;
            
            // Add to the room mesh group
            roomMeshGroup.add(mesh);
            
            //console.log(`Plane ${index} added to room mesh group (no transforms needed)`);
        });

        // Add meshes
        geometries.meshes.forEach((meshData, index) => {
            const material = new MeshBasicMaterial({
                wireframe: true,
                color: Math.random() * 0xffffff,
            });
            const mesh = new Mesh(meshData.geometry, material);
            
            //console.log(`Mesh ${index} semantic label:`, meshData.semanticLabel);
            
            // No transformations needed - geometry is already positioned correctly
            mesh.visible = roomMeshVisible;
            mesh.userData.semanticLabel = meshData.semanticLabel;
            
            // Add to the room mesh group
            roomMeshGroup.add(mesh);
            
            //console.log(`Mesh ${index} added to room mesh group (no transforms needed)`);
        });
        
        // For desktop mode, apply rotation to the entire room mesh group if needed
        if (isDesktopMode) {
            // roomMeshGroup.rotateZ(1 * Math.PI / 2);
            //console.log('Applied rotation to entire room mesh group for desktop viewing');
        }
        
        // Add the room mesh group to the scene
        scene.add(roomMeshGroup);
        //console.log('Room mesh group added to scene with', roomMeshGroup.children.length, 'objects');
        
        return roomMeshGroup;
    }

    /**
     * Toggle room mesh visibility for both VR and desktop modes
     */
    toggleRoomMeshVisibility(visible, ratk, scene, isDesktopMode) {
        //console.log('Toggling room mesh visibility to:', visible);
        
        // Handle VR mode - toggle RATK planes and meshes
        if (ratk && ratk.planes) {
            ratk.planes.forEach((plane) => {
                if (plane.planeMesh) {
                    plane.planeMesh.visible = visible;
                }
            });
        }
        
        if (ratk && ratk.meshes) {
            ratk.meshes.forEach((mesh) => {
                if (mesh.meshMesh) {
                    mesh.meshMesh.visible = visible;
                }
            });
        }
        
        // Handle desktop mode - toggle imported room mesh objects
        if (isDesktopMode && scene) {
            scene.traverse((object) => {
                // Look for objects with room mesh semantic labels (planes and meshes)
                if (object.userData && object.userData.semanticLabel) {
                    object.visible = visible;
                }
            });
        }
        
        //console.log(`Room mesh visibility set to ${visible}. VR Planes: ${ratk?.planes?.size || 0}, VR Meshes: ${ratk?.meshes?.size || 0}`);
        
        return visible;
    }

    /**
     * Export room mesh to server (called from VR mode)
     */
    async exportRoomMeshToServer(ratk, isDesktopMode) {
        if (isDesktopMode) {
            //console.log('Room mesh export only available in VR mode');
            return Promise.resolve({ error: 'Not available in desktop mode' });
        }

        try {
            //console.log('Exporting room mesh to server...');
            const result = await this.exportRoomMesh(ratk);
            
            //console.log('Room mesh exported successfully to mesh.json');
            //console.log('Desktop can now load the mesh by refreshing the page');
            
            return { success: true, message: 'Mesh exported to mesh.json' };
        } catch (error) {
            console.error('Failed to export room mesh:', error);
            return { error: error.message };
        }
    }

    /**
     * Make mesh functions available globally for external access
     */
    setupGlobalFunctions(ratk, isDesktopMode) {
        // Make the export function available globally
        window.exportRoomMeshToServer = async () => {
            try {
                const result = await this.exportRoomMeshToServer(ratk, isDesktopMode());
                return result;
            } catch (error) {
                console.error('Failed to export room mesh:', error);
                return { error: error.message };
            }
        };
    }

    generateId() {
        return Math.random().toString(36).substr(2, 9);
    }
}