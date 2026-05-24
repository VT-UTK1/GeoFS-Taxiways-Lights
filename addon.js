// ==UserScript==
// @name         GeoFS Taxiway Lights
// @version      1.0.0
// @description  Adds high-performance taxiway lights using OSM data (https://www.openstreetmap.org/copyright) with in-memory caching and Cesium BillboardCollection rendering.
// @author       VT-UTK
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=geo-fs.com
// @grant        none
// @downloadURL  https://github.com/VT-UTK/GeoFS-Taxiway-Lights/raw/refs/heads/main/addon.js
// @updateURL    https://github.com/VT-UTK/GeoFS-Taxiway-Lights/raw/refs/heads/main/addon.js
// ==/UserScript==

(function() {
    'use strict';

    // 1. Config & State Store
    const CONFIG = {
        chunkSize: 0.04,
        renderDist: 2, // 5x5 chunk grid (25 chunks total)
        defaultInterval: 5,
        defaultGSize: 0.05,
        defaultBSize: 0.07,
        offsetMeters: 10,
        overpassUrl: 'https://overpass.private.coffee/api/interpreter',
        gMenuJsDelivrUrl: 'https://cdn.jsdelivr.net/gh/tylerbmusic/GeoFS-Addon-Menu@main/addonMenu.js',
        gMenuFallbackUrl: 'https://raw.githubusercontent.com/tylerbmusic/GeoFS-Addon-Menu/refs/heads/main/addonMenu.js'
    };

    const STATE = {
        enabled: false,
        loadedChunks: {},       // boundStr -> { collection: Cesium.BillboardCollection, count: number }
        osmCache: {},           // boundStr -> Promise<Array<WayData>>
        runwayThresholds: [],   // Array<Array<[lon, lat, alt]>>
        lastNearRunwaysJson: '',
        lastLocation: [0, 0],
        updateInterval: CONFIG.defaultInterval,
        updateTimer: null
    };

    // 2. Math & Geographic Helpers (Corrected for Latitudinal Distortion)
    const EARTH_RADIUS = 6378137;

    /**
     * Calculates distance in meters between two points using local flat-earth approximation.
     * Incorporates latitudinal cosine scaling to resolve the high-latitude distortion bug.
     */
    function getDistanceMeters(lon1, lat1, lon2, lat2) {
        const latMidRad = ((lat1 + lat2) / 2) * Math.PI / 180;
        const dLonRad = (lon2 - lon1) * Math.PI / 180 * Math.cos(latMidRad);
        const dLatRad = (lat2 - lat1) * Math.PI / 180;
        return Math.sqrt(dLonRad * dLonRad + dLatRad * dLatRad) * EARTH_RADIUS;
    }

    /**
     * Calculates bearing in degrees (0-360) from point 1 to point 2.
     */
    function calculateBearing(lon1, lat1, lon2, lat2) {
        const dLonRad = (lon2 - lon1) * Math.PI / 180;
        const lat1Rad = lat1 * Math.PI / 180;
        const lat2Rad = lat2 * Math.PI / 180;

        const y = Math.sin(dLonRad) * Math.cos(lat2Rad);
        const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
                  Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLonRad);

        const bearing = Math.atan2(y, x) * 180 / Math.PI;
        return (bearing + 360) % 360;
    }

    /**
     * Computes the positive and negative perpendicular offset coordinates from a point based on bearing.
     */
    function calculateOffsetPoints(lon, lat, bearing, offsetDistance) {
        const bearingRad = (bearing + 90) * Math.PI / 180; // Perpendicular bearing

        const dLat = offsetDistance * Math.cos(bearingRad) / EARTH_RADIUS;
        const dLon = offsetDistance * Math.sin(bearingRad) / (EARTH_RADIUS * Math.cos(Math.PI * lat / 180));

        return {
            lonPlus: lon + dLon * 180 / Math.PI,
            latPlus: lat + dLat * 180 / Math.PI,
            lonMinus: lon - dLon * 180 / Math.PI,
            latMinus: lat - dLat * 180 / Math.PI
        };
    }

    /**
     * Interpolates points between a start and end coordinate at regular metric intervals.
     */
    function interpolatePoints(start, end, intervalMeters) {
        const [lon1, lat1] = start;
        const [lon2, lat2] = end;

        const distance = getDistanceMeters(lon1, lat1, lon2, lat2);
        const numPoints = Math.max(Math.floor(distance / intervalMeters), 1);
        const interpolated = [];

        for (let i = 0; i <= numPoints; i++) {
            const ratio = i / numPoints;
            const lon = lon1 + (lon2 - lon1) * ratio;
            const lat = lat1 + (lat2 - lat1) * ratio;
            interpolated.push([lon, lat, 0]);
        }

        return interpolated;
    }

    // 3. Dynamic Runway Proximity Detector
    function updateRunwayThresholds() {
        const nearRunways = window.geofs.runways.nearRunways;
        if (!nearRunways) return;

        // Check if the set of nearby runways has actually changed to avoid recalculating unnecessarily
        const runwayIds = Object.keys(nearRunways).sort().join(',');
        if (runwayIds === STATE.lastNearRunwaysJson) {
            return; 
        }

        STATE.lastNearRunwaysJson = runwayIds;
        STATE.runwayThresholds = [];

        for (const i in nearRunways) {
            const runway = nearRunways[i];
            const th1 = runway.threshold1;
            const th2 = runway.threshold2;
            if (th1 && th2) {
                // Interpolate runway points every 10 meters along its centerline
                const interpolated = interpolatePoints([th1[1], th1[0]], [th2[1], th2[0]], 10);
                STATE.runwayThresholds.push(interpolated);
            }
        }
    }

    function checkProximityToRunway(pos) {
        updateRunwayThresholds();
        const posLon = pos[0];
        const posLat = pos[1];
        const proximityThresholdMeters = 40; // 40-meter proximity threshold

        for (let i = 0; i < STATE.runwayThresholds.length; i++) {
            const pts = STATE.runwayThresholds[i];
            for (let j = 0; j < pts.length; j++) {
                const dist = getDistanceMeters(posLon, posLat, pts[j][0], pts[j][1]);
                if (dist < proximityThresholdMeters) {
                    return true;
                }
            }
        }
        return false;
    }

    // 4. Unified Overpass Fetcher with In-Memory Caching
    async function fetchTaxiwayData(bounds) {
        if (STATE.osmCache[bounds]) {
            return STATE.osmCache[bounds];
        }

        const query = `
            [out:json];
            (
                way["aeroway"="taxiway"](${bounds});
            );
            out body;
            >;
            out skel qt;
        `;

        const fetchPromise = (async () => {
            try {
                const response = await fetch(CONFIG.overpassUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Project-Name": "GeoFS Taxiway Lights Remastered",
                        "From": "https://tylerbmusic.github.io/contact"
                    },
                    body: "data=" + encodeURIComponent(query)
                });
                if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

                const data = await response.json();
                const nodes = {};

                data.elements.forEach(element => {
                    if (element.type === 'node') {
                        nodes[element.id] = element;
                    }
                });

                const ways = [];
                data.elements.forEach(element => {
                    if (element.type === 'way') {
                        const wayNodes = element.nodes.map(nodeId => nodes[nodeId]).filter(Boolean);
                        if (wayNodes.length > 1) {
                            ways.push({
                                id: element.id,
                                nodes: wayNodes.map(node => [node.lon, node.lat, 0]),
                                hasRef: element.tags && element.tags.ref ? true : false
                            });
                        }
                    }
                });

                return ways;
            } catch (error) {
                console.error(`[Taxiway Lights] Failed to fetch bounds ${bounds}:`, error);
                delete STATE.osmCache[bounds]; // Evict failed queries so they can be retried
                return [];
            }
        })();

        STATE.osmCache[bounds] = fetchPromise;
        return fetchPromise;
    }

    // 5. High-Performance Cesium Rendering Engine
    async function renderChunk(bounds) {
        if (STATE.loadedChunks[bounds]) return;

        const ways = await fetchTaxiwayData(bounds);
        if (!ways || ways.length === 0) return;

        // Retrieve dynamic dimensions from storage or fallback to defaults
        const gSize = Number(localStorage.getItem("twLGSize")) || CONFIG.defaultGSize;
        const bSize = Number(localStorage.getItem("twLBSize")) || CONFIG.defaultBSize;

        const scene = window.geofs.api.viewer.scene;
        const billboardCollection = scene.primitives.add(new window.Cesium.BillboardCollection());

        STATE.loadedChunks[bounds] = {
            collection: billboardCollection,
            count: 0
        };

        const resScale = window.geofs.api.renderingSettings.resolutionScale || 1.0;
        const scaleMultiplier = 1.0 / resScale;

        // Setup scale and transparency falloffs for crisp visuals & high FPS
        const scaleByDistance = new window.Cesium.NearFarScalar(10, 1.0, 2000, 0.2);
        const translucencyByDistance = new window.Cesium.NearFarScalar(10, 0.6, 10000, 0.1);

        ways.forEach(way => {
            const nodes = way.nodes;

            // --- CENTERLINE LIGHTS (Green / Runway Exit Yellow) ---
            const centerlineInterval = 7.5 + (Math.random() - 0.5) * 1.5;
            const centerlinePoints = [];

            for (let i = 0; i < nodes.length - 1; i++) {
                const segmentPoints = interpolatePoints(nodes[i], nodes[i + 1], centerlineInterval);
                if (i > 0) segmentPoints.shift(); // Deduplicate connection joints
                centerlinePoints.push(...segmentPoints);
            }

            centerlinePoints.forEach((epos, idx) => {
                const groundRes = window.geofs.getGroundAltitude([epos[1], epos[0], epos[2]]);
                const apos = groundRes ? groundRes.location : [epos[1], epos[0], epos[2]];
                const alt = (apos[2] || 0) + 0.3556; // Elevate 14 inches above surface

                let pos = window.Cesium.Cartesian3.fromDegrees(apos[1], apos[0], alt);
                if (pos.z < 0) pos.z = -pos.z; // Clean invalid negative z values

                const isNearRunway = checkProximityToRunway(epos);
                const lightImage = (idx % 2 === 0 && isNearRunway)
                    ? "https://tylerbmusic.github.io/GPWS-files_geofs/yellowlight.png"
                    : "https://tylerbmusic.github.io/GPWS-files_geofs/greenlight.png";

                billboardCollection.add({
                    position: pos,
                    image: lightImage,
                    scale: gSize * scaleMultiplier,
                    scaleByDistance: scaleByDistance,
                    translucencyByDistance: translucencyByDistance
                });
                STATE.loadedChunks[bounds].count++;
            });

            // --- EDGE LIGHTS (Blue) ---
            // Render edge lights on taxiways. Standard aviation design dictates blue edge lights for taxi limits.
            const edgeInterval = 18.0 + (Math.random() - 0.5) * 3;
            const edgePoints = [];

            for (let i = 0; i < nodes.length - 1; i++) {
                const segmentPoints = interpolatePoints(nodes[i], nodes[i + 1], edgeInterval);
                if (i > 0) segmentPoints.shift();

                const bearing = calculateBearing(nodes[i][0], nodes[i][1], nodes[i + 1][0], nodes[i + 1][1]);
                segmentPoints.forEach(([lon, lat, alt]) => {
                    const offset = calculateOffsetPoints(lon, lat, bearing, CONFIG.offsetMeters);
                    edgePoints.push(
                        [offset.lonPlus, offset.latPlus, alt],
                        [offset.lonMinus, offset.latMinus, alt]
                    );
                });
            }

            edgePoints.forEach(epos => {
                const groundRes = window.geofs.getGroundAltitude([epos[1], epos[0], epos[2]]);
                const apos = groundRes ? groundRes.location : [epos[1], epos[0], epos[2]];
                const alt = (apos[2] || 0) + 0.3556;

                let pos = window.Cesium.Cartesian3.fromDegrees(apos[1], apos[0], alt);
                if (pos.z < 0) pos.z = -pos.z;

                billboardCollection.add({
                    position: pos,
                    image: "https://tylerbmusic.github.io/GPWS-files_geofs/bluelight.png",
                    scale: bSize * scaleMultiplier,
                    scaleByDistance: scaleByDistance,
                    translucencyByDistance: translucencyByDistance
                });
                STATE.loadedChunks[bounds].count++;
            });
        });

    }

    function unloadChunk(bounds) {
        const chunk = STATE.loadedChunks[bounds];
        if (chunk) {
            const scene = window.geofs.api.viewer.scene;
            scene.primitives.remove(chunk.collection);
            delete STATE.loadedChunks[bounds];

        }
    }

    function clearAllChunks() {
        Object.keys(STATE.loadedChunks).forEach(bounds => {
            unloadChunk(bounds);
        });
        STATE.loadedChunks = {};
    }

    // 6. Chunk Grid Updating & Throttling Ticker
    function fpe(num) {
        return Number(num.toFixed(3));
    }

    async function tickChunks() {
        if (!STATE.enabled) {
            clearAllChunks();
            return;
        }

        if (!window.geofs || !window.geofs.aircraft || !window.geofs.aircraft.instance) return;

        // Skip loading if taxiway lights are disabled in local storage
        if (localStorage.getItem("twLEnabled") !== "true") {
            clearAllChunks();
            return;
        }

        const lla = window.geofs.aircraft.instance.llaLocation;
        if (!lla) return;

        // Throttling: Skip calculations if the aircraft has moved less than 50 meters
        const distMoved = getDistanceMeters(STATE.lastLocation[0], STATE.lastLocation[1], lla[1], lla[0]);
        if (distMoved < 50 && Object.keys(STATE.loadedChunks).length > 0) {
            return;
        }
        STATE.lastLocation = [lla[1], lla[0]];

        const chunkSize = CONFIG.chunkSize;
        const renderDist = CONFIG.renderDist;

        const currentLatChunk = Math.floor(lla[0] / chunkSize) * chunkSize;
        const currentLonChunk = Math.floor(lla[1] / chunkSize) * chunkSize;

        const activeBoundsSet = new Set();
        const chunksToLoad = [];

        // Build active rendering matrix
        for (let v = -renderDist; v <= renderDist; v++) {
            for (let h = -renderDist; h <= renderDist; h++) {
                const minLat = fpe(currentLatChunk + v * chunkSize);
                const minLon = fpe(currentLonChunk + h * chunkSize);
                const maxLat = fpe(currentLatChunk + (v + 1) * chunkSize);
                const maxLon = fpe(currentLonChunk + (h + 1) * chunkSize);

                const boundStr = `${minLat}, ${minLon}, ${maxLat}, ${maxLon}`;
                activeBoundsSet.add(boundStr);

                if (!STATE.loadedChunks[boundStr]) {
                    chunksToLoad.push(boundStr);
                }
            }
        }

        // Evict out-of-range chunks
        Object.keys(STATE.loadedChunks).forEach(bounds => {
            if (!activeBoundsSet.has(bounds)) {
                unloadChunk(bounds);
            }
        });

        // Load new chunks sequentially with a 200ms stagger to prevent API rate-limiting blocks
        for (let i = 0; i < chunksToLoad.length; i++) {
            const bounds = chunksToLoad[i];
            await new Promise(resolve => setTimeout(resolve, 200 * i));
            if (activeBoundsSet.has(bounds)) {
                renderChunk(bounds);
            }
        }
    }

    // 7. Loop Orchestration
    function updateLoop() {
        STATE.enabled = (localStorage.getItem("twLEnabled") === 'true');

        if (STATE.enabled) {
            tickChunks().catch(err => console.error("[Taxiway Lights] Update tick error:", err));
        } else {
            clearAllChunks();
        }

        const userInterval = Number(localStorage.getItem("twLUpdateInterval")) || CONFIG.defaultInterval;
        STATE.updateInterval = Math.max(userInterval, 2); // Enforce safety floor of 2s

        STATE.updateTimer = setTimeout(updateLoop, STATE.updateInterval * 1000);
    }

    // 8. Dynamic GMenu Injection and Init
    function loadAddonMenu() {
        return new Promise((resolve, reject) => {
            if (window.gmenu || window.GMenu) {
                resolve();
                return;
            }


            const script = document.createElement("script");
            script.src = CONFIG.gMenuJsDelivrUrl;
            script.onload = () => setTimeout(resolve, 150);
            script.onerror = () => {
                console.warn("[Taxiway Lights] CDN injection failed. Attempting GitHub raw fallback...");
                const fallbackScript = document.createElement("script");
                fallbackScript.src = CONFIG.gMenuFallbackUrl;
                fallbackScript.onload = () => setTimeout(resolve, 150);
                fallbackScript.onerror = () => reject(new Error("Unable to inject GMenu addon context."));
                document.head.appendChild(fallbackScript);
            };
            document.head.appendChild(script);
        });
    }

    function setupMenu() {
        if (!window.GMenu) return;
        if (window.twLMenuInitialized) return;
        window.twLMenuInitialized = true;

        const twLM = new window.GMenu("Taxiway Lights", "twL");
        twLM.addItem("Update Interval (seconds): ", "UpdateInterval", "number", 2, CONFIG.defaultInterval.toString());
        twLM.addItem("Green/Yellow Light Size: ", "GSize", "number", 0.01, CONFIG.defaultGSize.toString());
        twLM.addItem("Blue Light Size: ", "BSize", "number", 0.01, CONFIG.defaultBSize.toString());



        updateLoop();
        checkForUpdates();
        sendAnalytics();
    }

    async function init() {
        try {
            await loadAddonMenu();
            setupMenu();
        } catch (err) {
            console.error("[Taxiway Lights] Initialization sequence deferred:", err);
            setTimeout(init, 3000);
        }
    }

    // 9. Update Notifications & Privacy-Safe Analytics
    async function checkForUpdates() {
        const VERSION = "1.0.0";
        const LSNAME = "twL";

        try {
            if (localStorage.getItem(LSNAME + "U" + VERSION) !== "true") {
                localStorage.setItem(LSNAME + "U" + VERSION, "true");
                await fetch(`https://track.tylerbialowas-bard.workers.dev?event=${LSNAME}v${VERSION}`, { method: "HEAD" }).catch(() => {});
            }
        } catch (e) {
            // Silently ignore update stats errors
        }
    }

    async function sendAnalytics() {
        const SCRIPT_NAME = "Taxiway_Lights";
        let userId = localStorage.getItem("myScriptUserId");

        if (!userId) {
            userId = crypto.randomUUID();
            localStorage.setItem("myScriptUserId", userId);
        }

        try {
            await fetch("https://track.tylerbialowas-bard.workers.dev", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    script: SCRIPT_NAME,
                    userId: userId
                }),
            });
        } catch (error) {
            console.warn("[Taxiway Lights] Analytics logging skipped:", error);
        }
    }

    // Launch!
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init);
    }
  console.log("Taxiway Lights turned on succesfully!")
})();
