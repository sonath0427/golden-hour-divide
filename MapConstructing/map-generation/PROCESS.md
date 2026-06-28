# Method and Processing Notes

This document describes the processing pipeline used to generate the Sri Lanka research maps and the derived accessibility surfaces. It is written for research documentation and paper preparation.

## 1. Objective

The goal is to transform raw OSM roads, hospital coordinates, and a DEM into map layers that show:

- drivable road structure
- elevation-informed road difficulty
- modeled road speed
- modeled travel time to ICU hospitals
- multi-resolution accessibility heatmaps
- terrain and contour context for interpretation

The final outputs are designed for both analysis and browser delivery.

## 2. Input datasets

### Roads

Two roads inputs are used across the notebooks:

- `data/hotosm_lka_roads_lines_geojson.geojson` for the database staging notebook
- `data/datasets/osm/sri-lanka.gpkg` for the main extractor notebook

The GeoPackage is the main source for the research pipeline. It contains OSM layers, and the notebook selects the roads layer dynamically.

### Hospitals

The ICU hospital file is:

- `data/DS-Research-ICU-With-Latitude-Longitude.csv`

The notebook keeps only rows with valid latitude and longitude and converts them to point geometry.

### Elevation / DEM

The elevation raster is expected at:

- `data/datasets/dem/sri-lanka-dem.tif`

If the file is missing, the notebook still runs, but elevation-driven road attributes become unavailable and the speed model is less informative.

### Boundary support

The pipeline infers a Sri Lanka boundary from OSM administrative or boundary layers when available, and falls back to a roads-based convex hull if needed. This ensures the H3 grid is clipped to the island rather than to a simple bounding box.

## 3. Road staging in the first notebook

The `map-data-builder.ipynb` notebook performs database staging:

1. read the roads GeoJSON
2. remove empty or invalid geometries
3. keep only line geometries
4. write roads into PostGIS
5. create a primary key on `osm_id`
6. create geometry and highway indexes
7. export a complete roads GeoJSON copy
8. build a Folium preview map

This notebook is mainly a data preparation and validation step. It confirms that the roads can be stored and rendered before the research layers are generated.

## 4. Road filtering and classification

In the main extractor notebook, roads are first normalized to WGS84 and then filtered into drivable and non-drivable classes.

The non-drivable set includes classes such as:

- path
- footway
- pedestrian
- steps
- cycleway
- bridleway
- track_grade5
- service

The drivable roads are assigned:

- `base_speed` from a road-class speed map
- `draw_priority` from a road-class rendering priority map
- `length_m` from the geometry length in UTM Zone 44N

## 5. Elevation sampling and grade

The pipeline samples the DEM at three points on every road segment:

- start point
- midpoint
- endpoint

This creates the following fields:

- `start_z`
- `mid_z`
- `end_z`
- `grade`
- `elevation_available`

The road grade is computed as:

$$
\text{grade} = \frac{|\text{end\_z} - \text{start\_z}|}{\text{length\_m}}
$$

If the DEM is unavailable, grade is set to $0$ and elevation availability is marked false.

### Why this matters

The elevation fields are useful for diagnosing steep segments and for adding terrain sensitivity to the road-speed model.

## 6. Road speed model

Road speed starts from the road-class base speed and is then adjusted by grade.

### Base speed

Each road class receives a default speed, for example:

- motorway: 90 km/h
- trunk: 80 km/h
- primary: 70 km/h
- secondary: 60 km/h
- tertiary: 45 km/h
- residential: 30 km/h
- unclassified: 28 km/h
- service: 20 km/h
- track: 18 km/h
- living_street: 20 km/h

### Grade adjustment

The notebook uses a capped grade penalty so steep or noisy values do not collapse the speed surface.

The current adjustment logic is:

- convert grade to a percentage
- cap grade at 50% before applying the penalty
- apply a reduction of 0.5% speed for each 1% grade
- cap the total reduction at 75%
- never allow the adjusted speed to drop below 5 km/h

In formula form:

$$
\text{adj\_speed} = \max\left(\text{base\_speed} \times (1 - \text{speed\_reduction}), 5\right)
$$

where

$$
\text{speed\_reduction} = \min(0.5 \times \text{grade\_pct}, 0.75)
$$

The notebook also documents that an earlier linear formula of the form $1 - 1.5 \times \text{grade}$ produced unrealistic negative multipliers and was replaced.

### Road travel time

Road-segment travel time is computed as:

$$
\text{travel\_time\_mins} = \left(\frac{\text{length\_m} / 1000}{\text{adj\_speed}}\right) \times 60
$$

This is a segment-level diagnostic and export field. It is not the final hospital accessibility metric.

## 7. H3 road-speed surface

The pipeline samples the road network into H3 hexagons at resolution 8.

### Sampling procedure

For each road segment:

1. convert geometry into UTM for length-based sampling
2. sample points every 250 m along the segment
3. convert each sample point back to WGS84
4. assign the sample to an H3 cell at resolution 8
5. store the road speed for that cell

If multiple road samples fall in the same hex, the median speed is used.

### Output layers

- `hex_speed_raw_res8.geojson`
- `hex_speed_knn_res8.geojson`

### Raw speed surface

The raw surface contains only hexes touched by road samples. It is a direct observation layer and shows where road data are present.

### KNN-filled speed surface

Missing hexes are filled in two stages:

1. KNN regression on hex-centroid latitude and longitude with $k=5$ and distance weighting
2. neighborhood smoothing using H3 grid neighbors at radius 1

This creates a full surface across the Sri Lanka boundary and reduces holes where roads are sparse.

### Why both are useful

- Raw surface: shows directly observed road evidence
- KNN surface: gives a continuous national surface for downstream analysis and visualization

## 8. Hospital-accessibility travel time

The final heatmap is not based on graph shortest paths. Instead, it uses a modeled travel-time proxy from each H3 cell to each ICU hospital.

### Distance model

The distance from a hex centroid to a hospital is computed using the haversine formula:

$$
\text{distance\_km} = R \cdot c \cdot \text{detour\_factor}
$$

with:

- $R = 6371.0088$ km
- $c$ as the haversine central angle
- `detour_factor = 1.35`

The detour factor inflates straight-line distance to better approximate network travel distance.

### Time model

For each hex and each hospital:

$$
\text{time\_mins} = \frac{\text{distance\_km}}{\max(\text{hex\_speed\_kmh}, 5)} \times 60
$$

The pipeline then keeps the three nearest hospitals by time and stores:

- `nearest_hospital_1`
- `nearest_hospital_2`
- `nearest_hospital_3`
- `nearest_district_1`
- `nearest_district_2`
- `nearest_district_3`
- `time_to_hosp_1_min`
- `time_to_hosp_2_min`
- `time_to_hosp_3_min`
- `time_band`

### Time bands

The first-hospital travel time is classified into these bands:

- <15 min
- 15–30 min
- 30–45 min
- 45–50 min
- 50–75 min
- 75–90 min
- > 90 min

These bands drive the choropleth colors.

### Output layers

- `h3_heatmap_raw_res6.geojson`
- `h3_heatmap_raw_res7.geojson`
- `h3_heatmap_raw_res8.geojson`
- `h3_heatmap_knn_res6.geojson`
- `h3_heatmap_knn_res7.geojson`
- `h3_heatmap_knn_res8.geojson`

## 9. What each sub-map contributes

### `roads_considered.geojson`

Shows the drivable road network after filtering. This is the core infrastructure layer and the starting point for all derived calculations.

### `roads_elevation_inputs.geojson`

Contains the road attributes used to inspect elevation effects:

- length
- start and end elevation
- grade
- base speed
- adjusted speed
- travel time

This is a validation layer for checking whether DEM sampling is behaving as expected.

### `hex_speed_raw_res8.geojson`

Shows the observed road-speed surface at H3 resolution 8. It is useful for seeing where actual road evidence exists and where coverage gaps remain.

### `hex_speed_knn_res8.geojson`

Shows the gap-filled and smoothed speed surface. It is a more continuous representation of accessibility and is better for national-scale interpretation.

### `h3_heatmap_raw_res6/7/8.geojson`

These are the raw travel-time heatmaps at three display scales:

- res6 for country-scale viewing
- res7 for regional viewing
- res8 for local detail

The lower-resolution layers reduce clutter and file size at smaller zooms.

### `h3_heatmap_knn_res6/7/8.geojson`

These are the KNN-filled versions of the travel-time heatmap. They are the main accessibility visualization layers because they preserve continuity across the island.

### `icu_hospitals.geojson`

Provides the hospital reference points used in the travel-time computation and in the map overlays.

### `sri_lanka_boundary.geojson`

Used to clip the H3 grid to the island boundary.

### `preview_heatmap_raw.html` and `preview_heatmap_knn.html`

Quick Folium previews for checking that the heatmap colors and hospital overlays are correct.

### PMTiles outputs

The PMTiles bundle is the browser-delivery version of the same research layers. It includes roads, hospitals, heatmaps, terrain RGB, and contours.

## 10. Why the multi-resolution design helps

The same phenomenon is represented at multiple resolutions so the map remains readable at different zoom levels.

- res6: broad national patterns
- res7: provincial or district patterns
- res8: localized accessibility differences

This avoids overplotting and lets readers see both the broad gradient and the fine-scale variation.

## 11. Terrain and contours

The PMTiles block also produces terrain support layers from the DEM.

### Terrain-RGB

The DEM is encoded using the Mapbox Terrain-RGB convention:

$$
\text{encoded} = \left\lfloor \frac{\text{elevation} + 10000}{0.1} \right\rceil
$$

This is converted into RGB tiles and packaged into PMTiles for terrain rendering.

### Contours

Contour lines are generated at 20 m intervals and then tiled for browser rendering. These give a second terrain reference beyond the shaded relief.

## 12. Reproducibility notes

- Run notebooks from the repository root.
- Keep the input paths exactly as documented above.
- If you change the speed map or grade penalty, regenerate all H3 and PMTiles outputs.
- If the DEM changes, regenerate the elevation, speed, heatmap, contour, and terrain outputs.
- The PMTiles manifest should always be rebuilt after changing source GeoJSON files.

## 13. Interpretation caveat

The travel-time layer is a modeled accessibility surface, not a field-verified ambulance routing model. It is intended for comparative spatial analysis, not for operational dispatch planning.

## 14. Summary of the analytical chain

1. OSM roads are cleaned and classified.
2. Elevation samples are taken from the DEM.
3. Road speeds are adjusted using grade.
4. Road speeds are rasterized into H3 hexes.
5. Missing hexes are filled with KNN and smoothed.
6. Hex speeds are converted to hospital travel times using a detour factor.
7. Results are classified into time bands.
8. Multi-resolution GeoJSON, HTML previews, and PMTiles are exported.

This chain is the basis for the research figures and map products.
