"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { cellToBoundary, latLngToCell, polygonToCells } from "h3-js";
import Papa from "papaparse";
import { Protocol } from "pmtiles";

type Resolution = 5 | 6 | 7 | 8;
type BasemapType = "street" | "minimal";

interface HospitalData {
  District: string;
  Hospital_Name: string;
  Hospital_Type: string;
  Total_Beds: number;
  Latitude: number;
  Longitude: number;
}

type PMTilesManifest = {
  sources: {
    roads: { url: string; source_layers: string[] };
    hospitals: { url: string; source_layers: string[] };
    heatmap_raw: { url: string; source_layers: string[] };
    heatmap_knn: { url: string; source_layers: string[] };
    terrain_rgb: { url: string; encoding?: string };
    contours: { url: string; source_layers: string[] };
    network_gap: { url: string; source_layers: string[] };
  };
  style?: {
    time_band_colors?: Record<string, string>;
    contour_color?: string;
    gap_band_colors?: Record<string, string>;
  };
};

type PMTilesLayerKey = "terrain" | "roads" | "hospitals" | "heatmapRaw" | "heatmapKnn" | "contours";

const PMTILES_TOGGLES: Array<{ key: PMTilesLayerKey; label: string }> = [
  { key: "terrain", label: "Terrain + Hillshade" },
  { key: "roads", label: "Roads" },
  { key: "hospitals", label: "Hospitals" },
  { key: "heatmapRaw", label: "Heatmap Raw" },
  { key: "heatmapKnn", label: "Heatmap KNN" },
  { key: "contours", label: "Contours" },
];

type HexFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: {
      h3: string;
      color?: string;
      value?: number;
      label?: string; // e.g. "12 min"
      metric?: string;
    };
    geometry: {
      type: "Polygon";
      coordinates: number[][][];
    };
  }>;
};

const emptyFeatureCollection: HexFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const sriLankaBoundingPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [79.55, 5.7],
      [81.95, 5.7],
      [81.95, 9.95],
      [79.55, 9.95],
      [79.55, 5.7],
    ],
  ],
};

const PMTILES_MANIFEST_URL = "/pmtiles/pmtiles_manifest.json";

const BASEMAP_OPTIONS: Array<{
  value: BasemapType;
  label: string;
  tiles: string[];
  attribution: string;
}> = [
  {
    value: "street",
    label: "Street map",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap contributors",
  },
  {
    value: "minimal",
    label: "Minimal no-label map",
    tiles: ["https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png"],
    attribution: "© OpenStreetMap contributors © CARTO",
  },
];

const PMTILES_LAYER_IDS = {
  terrain: "pm-terrain-hillshade",
  roads: "pm-roads-line",
  hospitals: "pm-hospitals-circle",
  rawRes6: "pm-heatmap-raw-res6",
  rawRes7: "pm-heatmap-raw-res7",
  rawRes8: "pm-heatmap-raw-res8",
  knnRes6: "pm-heatmap-knn-res6",
  knnRes7: "pm-heatmap-knn-res7",
  knnRes8: "pm-heatmap-knn-res8",
  contours: "pm-contours-line",
} as const;

const interpolateColor = (value: number, min: number, max: number): string => {
  // Clamp value to min/max
  if (value < min) value = min;
  if (value > max) value = max;

  if (max === min) return "rgba(34, 197, 94, 0.6)";

  // Normalize 0-1
  const n = (value - min) / (max - min);

  // HSL: 120 (green) -> 0 (red)
  // Low time (good) = Green, High time (bad) = Red
  const hue = (1 - n) * 120;
  return `hsla(${hue}, 80%, 45%, 0.6)`;
};

const setLayerVisibility = (map: maplibregl.Map, layerId: string, visible: boolean) => {
  if (map.getLayer(layerId)) {
    map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
  }
};

const setMultipleLayerVisibility = (map: maplibregl.Map, layerIds: string[], visible: boolean) => {
  layerIds.forEach((layerId) => setLayerVisibility(map, layerId, visible));
};

const getBoundaryStyle = (adminLevel: "0" | "1" | "2" | "3" | "4") => {
  return {
    color: "#7310b0",
    width: 3.0,
    opacity: 0.88,
  };
};

const buildHexData = (
  resolution: Resolution,
  hospitals: HospitalData[],
  boundaryGeoJson: GeoJSON.FeatureCollection | null,
): HexFeatureCollection => {
  // Determine valid cells from GeoJSON boundary if available
  const validCells = new Set<string>();

  if (boundaryGeoJson && boundaryGeoJson.features) {
    boundaryGeoJson.features.forEach((feature) => {
      if (feature.geometry.type === "Polygon") {
        const polyCells = polygonToCells(feature.geometry.coordinates as number[][][], resolution, true);
        polyCells.forEach((c) => validCells.add(c));
      } else if (feature.geometry.type === "MultiPolygon") {
        (feature.geometry.coordinates as number[][][][]).forEach((poly) => {
          const polyCells = polygonToCells(poly, resolution, true);
          polyCells.forEach((c) => validCells.add(c));
        });
      }
    });
  } else {
    // Fallback: Rectangle
    const polyCells = polygonToCells(sriLankaBoundingPolygon.coordinates, resolution, true);
    polyCells.forEach((c) => validCells.add(c));
  }

  // MODE 2: Standard Bed Density (Default)
  // Use validCells generated from geometry
  const cells = Array.from(validCells);

  // Map hospitals to H3 cells and sum up total beds
  const dataMap = new Map<string, number>();

  hospitals.forEach((h) => {
    if (!h.Latitude || !h.Longitude) return;
    try {
      const cell = latLngToCell(h.Latitude, h.Longitude, resolution);
      const current = dataMap.get(cell) || 0;
      dataMap.set(cell, current + (Number(h.Total_Beds) || 0));
    } catch {
      console.warn("Invalid coordinate for H3:", h);
    }
  });

  // Find max value for normalization
  let maxVal = 0;
  for (const v of dataMap.values()) {
    if (v > maxVal) maxVal = v;
  }

  return {
    type: "FeatureCollection",
    features: cells.map((cell) => {
      const boundary = cellToBoundary(cell, true);
      boundary.push(boundary[0]);

      const val = dataMap.get(cell);

      // Color scale based on total beds intensity
      let color = "#ffb347"; // default/empty
      if (val !== undefined && maxVal > 0) {
        // Normalize 0-1
        const intensity = Math.min(val / (maxVal * 0.6), 1); // Cap at 60% of max for visibility
        // Green scale: rgba(16, 185, 129, alpha)
        color = `rgba(16, 185, 129, ${0.3 + intensity * 0.7})`;
      }

      return {
        type: "Feature",
        properties: {
          h3: cell,
          color: color,
          value: val || 0,
        },
        geometry: {
          type: "Polygon",
          coordinates: [boundary],
        },
      };
    }),
  };
};

export default function HexMap() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const pmtilesProtocol = useMemo(() => new Protocol(), []);

  const [isMapReady, setIsMapReady] = useState(false);
  const resolution: Resolution = 8;
  const [basemapType, setBasemapType] = useState<BasemapType>("street");

  // Layer visibility states
  const [showGrid, setShowGrid] = useState(true);
  const [showHospitals, setShowHospitals] = useState(true);
  const [showHexBorders, setShowHexBorders] = useState(true);

  // Update Hex Outline Visibility
  useEffect(() => {
    if (!isMapReady || !mapRef.current) return;
    if (mapRef.current.getLayer("hex-outline")) {
      mapRef.current.setLayoutProperty("hex-outline", "visibility", showGrid && showHexBorders ? "visible" : "none");
    }
  }, [isMapReady, showGrid, showHexBorders]);

  // Data state
  const [hospitals, setHospitals] = useState<HospitalData[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  // PMTiles overlay state
  const [pmtilesReady, setPmtilesReady] = useState(false);
  const [pmtilesError, setPmtilesError] = useState<string | null>(null);
  const [pmtilesLayers, setPmtilesLayers] = useState({
    terrain: true,
    roads: true,
    hospitals: false,
    heatmapRaw: false,
    heatmapKnn: false,
    contours: false,
  });

  // Boundary State
  const [adminLevel, setAdminLevel] = useState<"0" | "1" | "2" | "3" | "4">("1");
  const [boundaryGeoJson, setBoundaryGeoJson] = useState<GeoJSON.FeatureCollection | null>(null);

  // Load Admin Boundary
  useEffect(() => {
    const loadBoundary = async () => {
      // ADM0 requested -> try ADM1 or specific file if available.
      // Assuming user only has ADM1-4.
      // If adminLevel is '0', we can default to ADM1 or use bounding box (null).
      // Let's use ADM1 for '0' (Province) as a base or just null for bounding box.
      // Actually, user might want "Whole Country" which usually implies ADM0.
      // But we have ADM1. Union of ADM1 is ADM0.
      // For simplicity: level '0' = no boundary filter (rectangular bounding box).

      if (adminLevel === "0") {
        setBoundaryGeoJson(null);
        return;
      }

      try {
        const url = `/geoBoundaries-LKA-ADM${adminLevel}.geojson`;
        // ADM3 and ADM4 are simplified in the file list
        const effectiveUrl =
          adminLevel === "3"
            ? "/geoBoundaries-LKA-ADM3_simplified.geojson"
            : adminLevel === "4"
              ? "/geoBoundaries-LKA-ADM4_simplified.geojson"
              : url;

        const res = await fetch(effectiveUrl);
        if (!res.ok) throw new Error("Failed to load boundary");
        const json = await res.json();
        setBoundaryGeoJson(json);
      } catch (e) {
        console.error("Failed to load admin boundary", e);
        setBoundaryGeoJson(null);
      }
    };
    loadBoundary();
  }, [adminLevel]);

  // Fetch CSV data
  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch("/DS-Research-ICU-With-Latitude-Longitude.csv");
        const reader = response.body?.getReader();
        const result = await reader?.read();
        const decoder = new TextDecoder("utf-8");
        const csv = decoder.decode(result?.value);

        const { data } = Papa.parse(csv, {
          header: true,
          skipEmptyLines: true,
          dynamicTyping: true,
        });

        // Basic validation/filtering
        const validData = (data as HospitalData[]).filter((d) => d.Latitude && d.Longitude && d.Hospital_Name);

        setHospitals(validData);
        setLoadingData(false);
      } catch (error) {
        console.error("Error loading CSV:", error);
        setLoadingData(false);
      }
    };

    fetchData();
  }, []);

  const rasterStyle = useMemo(() => {
    const selectedBasemap = BASEMAP_OPTIONS.find((option) => option.value === basemapType) ?? BASEMAP_OPTIONS[0];

    return {
      version: 8 as const,
      sources: {
        base: {
          type: "raster" as const,
          tiles: selectedBasemap.tiles,
          tileSize: 256,
          attribution: selectedBasemap.attribution,
        },
      },
      layers: [
        {
          id: "base-tiles",
          type: "raster" as const,
          source: "base",
        },
      ],
    };
  }, [basemapType]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: rasterStyle,
      center: [80.7, 7.9],
      zoom: 6.8,
      pitch: 55,
      bearing: -20,
      minZoom: 5,
      maxZoom: 14, // Allow closer zoom for points
      preserveDrawingBuffer: true,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      // Hex grid source/layers
      map.addSource("hex-grid", {
        type: "geojson",
        data: emptyFeatureCollection,
      });

      map.addLayer({
        id: "hex-fill",
        type: "fill",
        source: "hex-grid",
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": ["case", ["has", "value"], 0.6, 0.15],
        },
        layout: {
          visibility: "visible",
        },
      });

      map.addLayer({
        id: "hex-outline",
        type: "line",
        source: "hex-grid",
        paint: {
          "line-color": "#ff7a00",
          "line-width": 1,
        },
        layout: {
          visibility: "visible",
        },
      });

      // Hospital points source/layer
      map.addSource("hospitals", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });

      map.addLayer({
        id: "hospitals-circle",
        type: "circle",
        source: "hospitals",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 12, 8],
          "circle-color": "#ffffff",
          "circle-stroke-color": "#020617", // slate-950
          "circle-stroke-width": 1.5,
        },
        layout: {
          visibility: "visible",
        },
      });

      // Interactions
      map.on("click", (e) => {
        // If we clicked a hospital marker, let that handler take precedence (it stops propagation usually, but map logic is tricky)
        // We'll check if the point was on the hospital layer
        const features = map.queryRenderedFeatures(e.point, { layers: ["hospitals-circle"] });
        if (features.length > 0) return;
      });

      map.on("click", "hospitals-circle", (e) => {
        if (!e.features || e.features.length === 0) return;

        const feature = e.features[0];
        const props = feature.properties;

        if (feature.geometry.type !== "Point") return;
        const coordinates = (feature.geometry.coordinates as [number, number]).slice();

        // Ensure popup appears over the copy being pointed to
        while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
          coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
        }

        if (popupRef.current) popupRef.current.remove();

        const popupContent = `
          <div class="text-slate-900 p-1 min-w-[160px]">
            <h3 class="font-bold text-sm mb-1">${props.name}</h3>
            <div class="text-xs space-y-1">
              <p><span class="font-semibold text-slate-500">District:</span> ${props.district}</p>
              <p><span class="font-semibold text-slate-500">Type:</span> ${props.type}</p>
              <p><span class="font-semibold text-slate-500">Beds:</span> ${props.beds}</p>
            </div>
          </div>
        `;

        popupRef.current = new maplibregl.Popup({ closeButton: false })
          .setLngLat(coordinates as [number, number])
          .setHTML(popupContent)
          .addTo(map);
      });

      // Add click for Hex Grid
      map.on("click", "hex-fill", (e) => {
        if (!e.features || e.features.length === 0) return;
        const feature = e.features[0];
        const props = feature.properties;

        if (popupRef.current) popupRef.current.remove();

        // Center of the feature? Or just click location
        const { lng, lat } = e.lngLat;

        const label = props.label || props.value?.toFixed(2);
        const metric = props.metric || "Value";

        // Only show if we have a value
        if (label) {
          const content = `
             <div class="text-slate-900 p-1 min-w-[120px]">
               <h3 class="font-bold text-xs mb-1 uppercase text-slate-500 tracking-wider">Hex Cell</h3>
               <p><span class="font-semibold text-slate-700">${metric}:</span> ${label}</p>
               <p class="text-[10px] text-slate-400 mt-1">${props.h3}</p>
             </div>
            `;

          popupRef.current = new maplibregl.Popup({ closeButton: false })
            .setLngLat([lng, lat])
            .setHTML(content)
            .addTo(map);
        }
      });

      // Admin Boundary Source/Layer (Topmost)
      map.addSource("admin-boundary", {
        type: "geojson",
        data: emptyFeatureCollection,
      });
      map.addLayer({
        id: "admin-boundary-line",
        type: "line",
        source: "admin-boundary",
        paint: {
          "line-color": getBoundaryStyle(adminLevel).color,
          "line-width": getBoundaryStyle(adminLevel).width,
          "line-opacity": getBoundaryStyle(adminLevel).opacity,
        },
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
      });

      (async () => {
        try {
          maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);

          const response = await fetch(PMTILES_MANIFEST_URL);
          if (!response.ok) {
            throw new Error(`Failed to load ${PMTILES_MANIFEST_URL}`);
          }

          const manifest = (await response.json()) as PMTilesManifest;
          const pmtilesUrl = (fileName: string) => `pmtiles://${window.location.origin}/pmtiles/${fileName}`;

          map.addSource("pm-roads", {
            type: "vector",
            url: pmtilesUrl(manifest.sources.roads.url),
          });
          map.addSource("pm-hospitals", {
            type: "vector",
            url: pmtilesUrl(manifest.sources.hospitals.url),
          });
          map.addSource("pm-heatmap-raw", {
            type: "vector",
            url: pmtilesUrl(manifest.sources.heatmap_raw.url),
          });
          map.addSource("pm-heatmap-knn", {
            type: "vector",
            url: pmtilesUrl(manifest.sources.heatmap_knn.url),
          });
          map.addSource("pm-contours", {
            type: "vector",
            url: pmtilesUrl(manifest.sources.contours.url),
          });
          map.addSource("pm-terrain-dem", {
            type: "raster-dem",
            url: pmtilesUrl(manifest.sources.terrain_rgb.url),
            tileSize: 256,
            encoding:
              (manifest.sources.terrain_rgb.encoding as "mapbox" | "terrarium" | "custom" | undefined) ?? "mapbox",
          });

          // Enable true 3D terrain from DEM tiles (separate from hillshade styling).
          map.setTerrain({
            source: "pm-terrain-dem",
            exaggeration: 1.2,
          });

          const bandColors = manifest.style?.time_band_colors ?? {
            "<15 min": "#e8f5d0",
            "15-30 min": "#b8e186",
            "30-45 min": "#7fbc41",
            "45-60 min": "#fddc6c",
            "60-75 min": "#fdae61",
            "75-90 min": "#f46d43",
            ">90 min": "#d73027",
          };
          const gapColors = manifest.style?.gap_band_colors ?? {
            "~Direct (<=1.15x)": "#d9f0d3",
            "Mild (1.15-1.35x)": "#a6d96a",
            "Moderate (1.35-1.6x)": "#fdae61",
            "High (>1.6x)": "#d73027",
          };

          map.addLayer(
            {
              id: PMTILES_LAYER_IDS.terrain,
              type: "hillshade",
              source: "pm-terrain-dem",
              paint: {
                "hillshade-exaggeration": 0.45,
                "hillshade-shadow-color": "#5e6770",
                "hillshade-highlight-color": "#f2f5f7",
              },
            },
            "hex-fill",
          );

          map.addLayer(
            {
              id: PMTILES_LAYER_IDS.roads,
              type: "line",
              source: "pm-roads",
              "source-layer": manifest.sources.roads.source_layers[0],
              paint: {
                "line-color": "#2563eb",
                "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.4, 12, 1.8],
                "line-opacity": 0.75,
              },
            },
            "hospitals-circle",
          );

          const addHeatmapLayers = (sourceId: string, layerIds: readonly string[]) => {
            layerIds.forEach((layerId, index) => {
              const sourceLayer =
                manifest.sources[sourceId === "pm-heatmap-raw" ? "heatmap_raw" : "heatmap_knn"].source_layers[index];
              map.addLayer(
                {
                  id: layerId,
                  type: "fill",
                  source: sourceId,
                  "source-layer": sourceLayer,
                  minzoom: index === 0 ? 0 : index === 1 ? 5 : 7,
                  maxzoom: index === 0 ? 5 : index === 1 ? 7 : 24,
                  paint: {
                    "fill-color": [
                      "match",
                      ["get", "time_band"],
                      "<15 min",
                      bandColors["<15 min"] ?? "#e8f5d0",
                      "15-30 min",
                      bandColors["15-30 min"] ?? "#b8e186",
                      "30-45 min",
                      bandColors["30-45 min"] ?? "#7fbc41",
                      "45-60 min",
                      bandColors["45-60 min"] ?? "#fddc6c",
                      "60-75 min",
                      bandColors["60-75 min"] ?? "#fdae61",
                      "75-90 min",
                      bandColors["75-90 min"] ?? "#f46d43",
                      ">90 min",
                      bandColors[">90 min"] ?? "#d73027",
                      "#cccccc",
                    ],
                    "fill-opacity": 0.55,
                    "fill-outline-color": [
                      "match",
                      ["get", "time_band"],
                      "<15 min",
                      bandColors["<15 min"] ?? "#e8f5d0",
                      "15-30 min",
                      bandColors["15-30 min"] ?? "#b8e186",
                      "30-45 min",
                      bandColors["30-45 min"] ?? "#7fbc41",
                      "45-60 min",
                      bandColors["45-60 min"] ?? "#fddc6c",
                      "60-75 min",
                      bandColors["60-75 min"] ?? "#fdae61",
                      "75-90 min",
                      bandColors["75-90 min"] ?? "#f46d43",
                      ">90 min",
                      bandColors[">90 min"] ?? "#d73027",
                      "#cccccc",
                    ],
                  },
                },
                "hospitals-circle",
              );
            });
          };

          addHeatmapLayers("pm-heatmap-raw", [
            PMTILES_LAYER_IDS.rawRes6,
            PMTILES_LAYER_IDS.rawRes7,
            PMTILES_LAYER_IDS.rawRes8,
          ]);
          addHeatmapLayers("pm-heatmap-knn", [
            PMTILES_LAYER_IDS.knnRes6,
            PMTILES_LAYER_IDS.knnRes7,
            PMTILES_LAYER_IDS.knnRes8,
          ]);

          map.addLayer(
            {
              id: PMTILES_LAYER_IDS.hospitals,
              type: "circle",
              source: "pm-hospitals",
              "source-layer": manifest.sources.hospitals.source_layers[0],
              paint: {
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 2.5, 12, 4.8],
                "circle-color": "#ffffff",
                "circle-stroke-color": "#111827",
                "circle-stroke-width": 1.1,
              },
            },
            "hospitals-circle",
          );

          map.addLayer(
            {
              id: PMTILES_LAYER_IDS.contours,
              type: "line",
              source: "pm-contours",
              "source-layer": manifest.sources.contours.source_layers[0],
              paint: {
                "line-color": manifest.style?.contour_color ?? "#8b7b6a",
                "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.2, 12, 0.55],
                "line-opacity": 0.5,
              },
            },
            "hospitals-circle",
          );

          const pmHeatmapLayerIds = [
            PMTILES_LAYER_IDS.rawRes6,
            PMTILES_LAYER_IDS.rawRes7,
            PMTILES_LAYER_IDS.rawRes8,
            PMTILES_LAYER_IDS.knnRes6,
            PMTILES_LAYER_IDS.knnRes7,
            PMTILES_LAYER_IDS.knnRes8,
          ];

          pmHeatmapLayerIds.forEach((layerId) => {
            map.on("mouseenter", layerId, () => {
              map.getCanvas().style.cursor = "pointer";
            });
            map.on("mouseleave", layerId, () => {
              map.getCanvas().style.cursor = "";
            });
            map.on("click", layerId, (e) => {
              if (!e.features || e.features.length === 0) return;

              const feature = e.features[0];
              const props = feature.properties || {};
              const title = props.gap_band ? "Network gap" : "H3 travel time";
              const valueText = props.gap_band
                ? `<p><span class="font-semibold text-slate-700">Gap ratio:</span> ${Number(props.gap_ratio || 0).toFixed(2)}x</p><p><span class="font-semibold text-slate-700">Gap:</span> ${Number(props.gap_min || 0).toFixed(1)} min</p>`
                : `<p><span class="font-semibold text-slate-700">Time:</span> ${Number(props.time_to_hosp_1_min || 0).toFixed(1)} min</p><p><span class="font-semibold text-slate-700">Band:</span> ${props.time_band || "Unknown"}</p>`;

              if (popupRef.current) popupRef.current.remove();
              popupRef.current = new maplibregl.Popup({ closeButton: false })
                .setLngLat(e.lngLat)
                .setHTML(
                  `
                    <div class="text-slate-900 p-1 min-w-[150px]">
                      <h3 class="font-bold text-xs mb-1 uppercase text-slate-500 tracking-wider">${title}</h3>
                      ${valueText}
                      <p class="text-[10px] text-slate-400 mt-1">${props.hex_id || props.h3 || ""}</p>
                    </div>
                  `,
                )
                .addTo(map);
            });
          });

          setPmtilesError(null);
          setPmtilesReady(true);
        } catch (error) {
          console.error("PMTiles overlay load failed", error);
          setPmtilesError(error instanceof Error ? error.message : "Failed to load PMTiles overlays");
          setPmtilesReady(false);
        }
      })();

      // Cursor pointer on hover
      map.on("mouseenter", "hospitals-circle", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "hospitals-circle", () => {
        map.getCanvas().style.cursor = "";
      });

      setIsMapReady(true);
      requestAnimationFrame(() => map.resize());
      setTimeout(() => map.resize(), 200);
    });

    mapRef.current = map;

    const resizeObserver = new ResizeObserver(() => {
      map.resize();
    });

    resizeObserver.observe(mapContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (popupRef.current) {
        popupRef.current.remove();
        popupRef.current = null;
      }
      map.remove();
      mapRef.current = null;
      setIsMapReady(false);
      setPmtilesReady(false);
      maplibregl.removeProtocol("pmtiles");
    };
  }, [pmtilesProtocol, rasterStyle]);

  const hexData = useMemo(
    () => buildHexData(resolution, hospitals, boundaryGeoJson),
    [resolution, hospitals, boundaryGeoJson],
  );

  useEffect(() => {
    if (!isMapReady || !mapRef.current) return;

    setLayerVisibility(mapRef.current, "hex-fill", showGrid);
    setLayerVisibility(mapRef.current, "hospitals-circle", showHospitals);
  }, [isMapReady, showGrid, showHospitals]);

  useEffect(() => {
    if (!isMapReady || !mapRef.current) return;

    setLayerVisibility(mapRef.current, PMTILES_LAYER_IDS.terrain, pmtilesLayers.terrain);
    if (mapRef.current.getSource("pm-terrain-dem")) {
      mapRef.current.setTerrain(pmtilesLayers.terrain ? { source: "pm-terrain-dem", exaggeration: 1.2 } : null);
    }
    setLayerVisibility(mapRef.current, PMTILES_LAYER_IDS.roads, pmtilesLayers.roads);
    setLayerVisibility(mapRef.current, PMTILES_LAYER_IDS.hospitals, pmtilesLayers.hospitals);
    setMultipleLayerVisibility(
      mapRef.current,
      [PMTILES_LAYER_IDS.rawRes6, PMTILES_LAYER_IDS.rawRes7, PMTILES_LAYER_IDS.rawRes8],
      pmtilesLayers.heatmapRaw,
    );
    setMultipleLayerVisibility(
      mapRef.current,
      [PMTILES_LAYER_IDS.knnRes6, PMTILES_LAYER_IDS.knnRes7, PMTILES_LAYER_IDS.knnRes8],
      pmtilesLayers.heatmapKnn,
    );
    setLayerVisibility(mapRef.current, PMTILES_LAYER_IDS.contours, pmtilesLayers.contours);
  }, [isMapReady, pmtilesLayers]);

  useEffect(() => {
    if (!isMapReady || !mapRef.current) return;

    const hexSource = mapRef.current.getSource("hex-grid") as maplibregl.GeoJSONSource | undefined;
    if (hexSource) {
      hexSource.setData(hexData as GeoJSON.FeatureCollection);
    }

    const hospitalsSource = mapRef.current.getSource("hospitals") as maplibregl.GeoJSONSource | undefined;
    if (hospitalsSource) {
      hospitalsSource.setData({
        type: "FeatureCollection",
        features: hospitals.map((h) => ({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [h.Longitude, h.Latitude],
          },
          properties: {
            name: h.Hospital_Name,
            district: h.District,
            type: h.Hospital_Type,
            beds: h.Total_Beds,
          },
        })),
      });
    }

    const boundarySource = mapRef.current.getSource("admin-boundary") as maplibregl.GeoJSONSource | undefined;
    if (boundarySource) {
      boundarySource.setData((boundaryGeoJson ?? emptyFeatureCollection) as GeoJSON.FeatureCollection);
    }

    if (mapRef.current.getLayer("admin-boundary-line")) {
      const style = getBoundaryStyle(adminLevel);
      mapRef.current.setPaintProperty("admin-boundary-line", "line-color", style.color);
      mapRef.current.setPaintProperty("admin-boundary-line", "line-width", style.width);
      mapRef.current.setPaintProperty("admin-boundary-line", "line-opacity", style.opacity);
      mapRef.current.setLayoutProperty("admin-boundary-line", "visibility", adminLevel === "0" ? "none" : "visible");
    }
  }, [adminLevel, boundaryGeoJson, hexData, hospitals, isMapReady]);

  const handleExportImage = () => {
    if (!mapRef.current) return;
    const dataUrl = mapRef.current.getCanvas().toDataURL("image/jpeg", 0.92);
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = "research-map-view.jpg";
    link.click();
  };

  return (
    <section className="fixed inset-0 h-full w-full overflow-hidden bg-slate-950">
      <div className="absolute inset-0">
        <div
          ref={mapContainerRef}
          className="absolute inset-0 z-0 bg-slate-800"
          style={{ width: "100%", height: "100%" }}
        />
        {!isMapReady && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-300 z-50 bg-slate-950">
            <div className="flex flex-col items-center gap-2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-white" />
              <span>Loading map...</span>
            </div>
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(circle_at_top,_rgba(15,23,42,0.1),_transparent_55%)]" />

      <div className="pointer-events-none absolute left-6 right-6 top-6 z-20 flex flex-wrap items-center justify-between gap-4">
        <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-white/10 bg-slate-950/80 px-4 py-2 text-xs text-slate-100 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-slate-950/60">
          <span className="text-[11px] uppercase tracking-[0.35em] text-slate-400">Research Map</span>
          <span className="hidden text-slate-300 sm:inline">Sri Lanka | ICU Beds</span>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-6 left-6 z-20 flex flex-col gap-2">
        <div className="rounded-lg border border-white/10 bg-slate-950/80 p-3 shadow-lg backdrop-blur">
          <h4 className="mb-2 text-[10px] uppercase tracking-[0.2em] text-slate-400">Bed Density (Hex)</h4>
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <div className="h-3 w-3 rounded-sm bg-[#ffb347] opacity-20 border border-[#ff7a00]"></div>
            <span>Low / None</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-300">
            <div className="h-3 w-3 rounded-sm bg-emerald-500 border border-emerald-600"></div>
            <span>High Capacity</span>
          </div>
        </div>
      </div>

      <div className="absolute right-6 top-24 z-20 w-64 rounded-xl border border-white/10 bg-slate-950/90 p-4 shadow-xl backdrop-blur">
        <div className="mb-4 border-b border-white/10 pb-2">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-200">Layers & Filters</h3>
        </div>

        <div className="mb-4">
          <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Map Type</label>
          <select
            value={basemapType}
            onChange={(e) => setBasemapType(e.target.value as BasemapType)}
            className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
          >
            {BASEMAP_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="mt-1 text-[9px] leading-tight text-slate-500">
            The minimal map uses a free label-free basemap.
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">Boundary Level</label>
          <select
            value={adminLevel}
            onChange={(e) => setAdminLevel(e.target.value as "0" | "1" | "2" | "3" | "4")}
            className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-sky-500"
          >
            <option value="0">Rectangular (None)</option>
            <option value="1">Level 1 (Province)</option>
            <option value="2">Level 2 (District)</option>
            <option value="3">Level 3 (DS Division)</option>
            <option value="4">Level 4 (GN Division)</option>
          </select>
          <div className="text-[9px] text-slate-500 mt-1 leading-tight">
            Filters hex cells to be inside the selected administrative boundary.
            {adminLevel !== "0" && !boundaryGeoJson && <span className="text-amber-400 ml-1">Loading...</span>}
          </div>
        </div>

        <div className="mb-4 rounded-lg border border-sky-500/15 bg-sky-500/5 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-sky-300">PMTiles layers</span>
            <span className={`text-[10px] ${pmtilesReady ? "text-emerald-300" : "text-slate-500"}`}>
              {pmtilesReady ? "Ready" : "Loading"}
            </span>
          </div>

          {pmtilesError && <p className="mb-2 text-[10px] leading-tight text-rose-300">{pmtilesError}</p>}

          <div className="space-y-2 text-sm">
            {PMTILES_TOGGLES.map(({ key, label }) => {
              const checked = pmtilesLayers[key];
              return (
                <label
                  key={key}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-white/5"
                >
                  <span className="text-xs text-slate-300">{label}</span>
                  <input
                    type="checkbox"
                    checked={Boolean(checked)}
                    onChange={(e) =>
                      setPmtilesLayers((prev) => ({
                        ...prev,
                        [key]: e.target.checked,
                      }))
                    }
                    className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500"
                  />
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <label className="flex cursor-pointer items-center justify-between group">
              <span className="text-sm text-slate-300 group-hover:text-white transition">H3 Hex Grid</span>
              <div
                className={`relative h-5 w-9 rounded-full transition-colors ${showGrid ? "bg-sky-500" : "bg-slate-700"}`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={showGrid}
                  onChange={(e) => setShowGrid(e.target.checked)}
                />
                <span
                  className={`absolute left-1 top-1 h-3 w-3 rounded-full bg-white transition-transform ${showGrid ? "translate-x-4" : "translate-x-0"}`}
                />
              </div>
            </label>

            {showGrid && (
              <label className="flex cursor-pointer items-center justify-between group pl-2 border-l-2 border-slate-700/50 ml-1">
                <span className="text-[11px] text-slate-400 group-hover:text-slate-300 transition">Show Borders</span>
                <div
                  className={`relative h-4 w-7 rounded-full transition-colors ${showHexBorders ? "bg-orange-500/80" : "bg-slate-700"}`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={showHexBorders}
                    onChange={(e) => setShowHexBorders(e.target.checked)}
                  />
                  <span
                    className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${showHexBorders ? "translate-x-3" : "translate-x-0"}`}
                  />
                </div>
              </label>
            )}
          </div>

          <label className="flex cursor-pointer items-center justify-between group">
            <div className="flex items-center gap-2">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white border-2 border-slate-900 shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-slate-900"></span>
              </span>
              <span className="text-sm text-slate-300 group-hover:text-white transition">Hospitals</span>
            </div>
            <div
              className={`relative h-5 w-9 rounded-full transition-colors ${showHospitals ? "bg-emerald-500" : "bg-slate-700"}`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={showHospitals}
                onChange={(e) => setShowHospitals(e.target.checked)}
              />
              <span
                className={`absolute left-1 top-1 h-3 w-3 rounded-full bg-white transition-transform ${showHospitals ? "translate-x-4" : "translate-x-0"}`}
              />
            </div>
          </label>
        </div>

        {loadingData && <div className="mt-4 text-xs text-slate-500 italic text-center">Updating dataset...</div>}

        <div className="mt-6 border-t border-slate-800 pt-4">
          <button
            onClick={handleExportImage}
            className="flex w-full items-center justify-center gap-2 rounded bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700 hover:text-white"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            Export View as JPG
          </button>
        </div>
      </div>
    </section>
  );
}
