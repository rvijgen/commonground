import {
    BufferGeometry,
    Float32BufferAttribute,
    Points,
    PointsMaterial,
    Color,
    Box3,
    Vector3,
    BoxGeometry,
    MeshBasicMaterial,
    Mesh,
    EdgesGeometry,
    LineSegments,
    LineBasicMaterial,
    Group
} from 'three';

/**
 * PointCloudLoader class for loading and converting JSON data into Three.js point clouds
 */
class PointCloudLoader {
    constructor() {
        this.geometry = null;
        this.points = null;
        this.material = null;
    }

    /**
     * Loads a JSON file from the specified URL and converts it to a Three.js Points mesh
     * @param {string} url - The URL of the JSON file to load
     * @param {Object} options - Configuration options
     * @param {number} options.pointSize - Size of the points (default: 0.05)
     * @param {string|Color} options.color - Default color for points (default: 0x00ff00)
     * @param {boolean} options.useClusterColors - Whether to use cluster-based coloring (default: true)
     * @param {Array} options.clusterColorPalette - Custom color palette for clusters
     * @returns {Promise<Points>} - Promise that resolves to a Three.js Points object
     */
    async load(url, options = {}) {
        try {
            // Set default options
            const config = {
                pointSize: options.pointSize || 0.05,
                color: options.color || 0x00ff00,
                useClusterColors: options.useClusterColors !== false,
                clusterColorPalette: options.clusterColorPalette || this._generateDefaultColorPalette(),
                ...options
            };

            // Fetch the JSON data - use Express server for assets
            let fetchUrl = url;
            
            
            console.log('Fetching point cloud data from:', fetchUrl);
            const response = await fetch(fetchUrl);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            // Read the response as text first
            const textData = await response.text();
            
            let jsonData;
            try {
                // Try to parse as JSON first
                jsonData = JSON.parse(textData);
            } catch (jsonError) {
                // If JSON parsing fails, try parsing as line-delimited arrays
                console.log('JSON parsing failed, trying line-delimited format...');
                jsonData = this._parseLineDelimitedData(textData);
            }
            
            // Parse the data and create geometry
            const parsedData = this._parseJsonData(jsonData);
            this.geometry = this._createBufferGeometry(parsedData, config);
            
            // Create material with VR optimizations
            const materialConfig = {
                size: config.pointSize,
                vertexColors: config.useClusterColors,
                sizeAttenuation: true, // Improves performance by not scaling points with distance
                alphaTest: 0.1, // Skip rendering transparent pixels
                transparent: false // Disable transparency for better performance

            };
            if (!config.useClusterColors) {
                materialConfig.color = new Color(config.color);
            }

            this.material = new PointsMaterial({
                ...materialConfig,

            });

            // Create Points mesh
            this.points = new Points(this.geometry, this.material);
            
            // Center the point cloud and add bounding box
            const centeredGroup = this._centerPointCloudWithBoundingBox(this.points);
            
            return centeredGroup;

        } catch (error) {
            console.error('Error loading point cloud:', error);
            throw error;
        }
    }

    /**
     * Parses line-delimited array data
     * @param {string} textData - Raw text data with arrays on each line
     * @returns {Array} - Array of parsed arrays
     */
    _parseLineDelimitedData(textData) {
        const lines = textData.trim().split('\n');
        const arrays = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line) {
                try {
                    const array = JSON.parse(line);
                    if (Array.isArray(array)) {
                        arrays.push(array);
                    }
                } catch (error) {
                    console.warn(`Failed to parse line ${i + 1}: ${line}`);
                }
            }
        }
        
        console.log(`Parsed ${arrays.length} arrays from line-delimited data`);
        return arrays;
    }

    /**
     * Parses JSON data and handles different possible structures
     * @param {*} jsonData - Raw JSON data
     * @returns {Array} - Parsed point data array
     */
    _parseJsonData(jsonData) {
        let pointsArray;

        // Handle different JSON structures
        if (Array.isArray(jsonData)) {
            // Direct array of points
            pointsArray = jsonData;
        } else if (jsonData.points && Array.isArray(jsonData.points)) {
            // Nested under 'points' property
            pointsArray = jsonData.points;
        } else if (jsonData.data && Array.isArray(jsonData.data)) {
            // Nested under 'data' property
            pointsArray = jsonData.data;
        } else {
            throw new Error('Unsupported JSON structure. Expected array of points or object with "points" or "data" property.');
        }

        // Validate and parse each point
        const parsedPoints = pointsArray.map((point, index) => {
            if (!Array.isArray(point) || point.length < 3) {
                console.warn(`Invalid point at index ${index}:`, point);
                return null;
            }

            const x = parseFloat(point[0]);
            const y = parseFloat(point[1]);
            const z = parseFloat(point[2]);
            
            if (isNaN(x) || isNaN(y) || isNaN(z)) {
                console.warn(`Invalid coordinates at index ${index}:`, point);
                return null;
            }

            return {
                x: x,
                y: y,
                z: z,
                index: point.length > 3 ? parseInt(point[3]) : index,
                cluster: point.length > 4 ? parseInt(point[4]) : 0,
                original: point
            };
        }).filter(point => point !== null);

        if (parsedPoints.length === 0) {
            throw new Error('No valid points found in the data.');
        }

        console.log(`Successfully parsed ${parsedPoints.length} points`);
        return parsedPoints;
    }

    /**
     * Optimizes point data for VR performance by reducing density
     * @param {Array} pointsData - Original point data
     * @param {number} maxPoints - Maximum number of points to render
     * @returns {Array} - Optimized point data
     */
    _optimizeForVR(pointsData, maxPoints = 700000) {
        if (pointsData.length <= maxPoints) {
            return pointsData;
        }
        
        // Use systematic sampling to maintain spatial distribution
        const step = Math.floor(pointsData.length / maxPoints);
        const optimized = [];
        
        for (let i = 0; i < pointsData.length; i += step) {
            optimized.push(pointsData[i]);
        }
        
        console.log(`Optimized point cloud from ${pointsData.length} to ${optimized.length} points for VR performance`);
        return optimized;
    }

    /**
     * Creates a BufferGeometry from parsed point data
     * @param {Array} pointsData - Parsed point data
     * @param {Object} config - Configuration options
     * @returns {BufferGeometry} - Three.js BufferGeometry
     */
    _createBufferGeometry(pointsData, config) {
        // Optimize for VR if we have too many points
        const optimizedData = this._optimizeForVR(pointsData, config.maxPoints || 50000);
        
        const geometry = new BufferGeometry();
        
        // Create position array
        const positions = new Float32Array(optimizedData.length * 3);
        
        // Create color array if using cluster colors
        let colors = null;
        if (config.useClusterColors) {
            colors = new Float32Array(optimizedData.length * 3);
        }

        // Get unique clusters for color mapping
        const uniqueClusters = [...new Set(optimizedData.map(point => point.cluster))];
        const clusterColorMap = this._createClusterColorMap(uniqueClusters, config.clusterColorPalette);

        // Fill arrays
        optimizedData.forEach((point, index) => {
            const i = index * 3;
            
            // Set position
            positions[i] = point.x;
            positions[i + 1] = point.y;
            positions[i + 2] = point.z;
            
            // Set color based on cluster
            if (colors) {
                const color = clusterColorMap.get(point.cluster);
                colors[i] = color.r;
                colors[i + 1] = color.g;
                colors[i + 2] = color.b;
            }
        });

        // Add attributes to geometry
        geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
        
        if (colors) {
            geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
        }

        // Compute bounding sphere for proper rendering
        geometry.computeBoundingSphere();

        return geometry;
    }

    /**
     * Creates a color map for clusters
     * @param {Array} clusters - Array of unique cluster IDs
     * @param {Array} palette - Color palette
     * @returns {Map} - Map of cluster ID to Color object
     */
    _createClusterColorMap(clusters, palette) {
        const colorMap = new Map();
        
        clusters.forEach((cluster, index) => {
            const colorIndex = index % palette.length;
            const color = new Color(palette[colorIndex]);
            colorMap.set(cluster, color);
        });

        return colorMap;
    }

    /**
     * Generates a default color palette
     * @returns {Array} - Array of hex color values
     */
    _generateDefaultColorPalette() {
        return [
            0xff0000, // Red
            0x00ff00, // Green
            0x0000ff, // Blue
            0xffff00, // Yellow
            0xff00ff, // Magenta
            0x00ffff, // Cyan
            0xff8000, // Orange
            0x8000ff, // Purple
            0x80ff00, // Lime
            0xff0080, // Pink
            0x0080ff, // Sky Blue
            0x80ff80, // Light Green
            0xff8080, // Light Red
            0x8080ff, // Light Blue
            0xffff80, // Light Yellow
            0xff80ff, // Light Magenta
            0x80ffff, // Light Cyan
            0xffc080, // Peach
            0xc080ff, // Lavender
            0x80ffc0, // Mint
        ];
    }

    /**
     * Updates the point size of the material
     * @param {number} size - New point size
     */
    setPointSize(size) {
        if (this.material) {
            this.material.size = size;
            this.material.needsUpdate = true;
        }
    }

    /**
     * Updates the color of all points (only works when not using cluster colors)
     * @param {string|number|Color} color - New color
     */
    setColor(color) {
        if (this.material && !this.material.vertexColors) {
            this.material.color = new Color(color);
            this.material.needsUpdate = true;
        }
    }

    /**
     * Gets information about the loaded point cloud
     * @returns {Object} - Point cloud information
     */
    getInfo() {
        if (!this.geometry) {
            return null;
        }

        const positions = this.geometry.attributes.position;
        const pointCount = positions ? positions.count : 0;
        
        return {
            pointCount: pointCount,
            hasColors: !!this.geometry.attributes.color,
            boundingSphere: this.geometry.boundingSphere,
            material: this.material ? {
                size: this.material.size,
                color: this.material.color,
                vertexColors: this.material.vertexColors
            } : null
        };
    }

    /**
     * Centers the point cloud at origin and adds a bounding box
     * @param {Points} pointsMesh - The points mesh to center
     * @returns {Group} - A group containing the centered points and bounding box
     */
    _centerPointCloudWithBoundingBox(pointsMesh) {
        // Calculate bounding box
        const box = new Box3().setFromObject(pointsMesh);
        const center = box.getCenter(new Vector3());
        const size = box.getSize(new Vector3());
        
        // Center the point cloud by moving it to origin
        pointsMesh.position.sub(center);
        
        // Create bounding box wireframe
        const boxGeometry = new BoxGeometry(size.x, size.y, size.z);
        const edges = new EdgesGeometry(boxGeometry);
        const lineMaterial = new LineBasicMaterial({ 
            color: 0x00ff00, 
            linewidth: 2,
            transparent: true,
            opacity: 0.6
        });
        const boundingBoxWireframe = new LineSegments(edges, lineMaterial);
        
        // Create a group to hold both the points and bounding box
        const group = new Group();
        group.add(pointsMesh);
        group.add(boundingBoxWireframe);
        
        // Scale the entire group
        group.scale.set(0.4, 0.4, 0.4);
        
        console.log(`Point cloud centered at origin. Size: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`);
        
        return group;
    }

    /**
     * Disposes of the geometry and material to free memory
     */
    dispose() {
        if (this.geometry) {
            this.geometry.dispose();
            this.geometry = null;
        }
        if (this.material) {
            this.material.dispose();
            this.material = null;
        }
        this.points = null;
    }
}

export default PointCloudLoader;