# Sri Lanka Research Map Generation

This repository builds Sri Lanka geospatial research layers from OpenStreetMap roads, a DEM, and an ICU-hospital point dataset. The pipeline produces analysis-ready GeoJSON, preview HTML, and PMTiles packages for browser-based visualization.

## What the project does

The workflow has two main notebook stages:

1. `map-data-builder.ipynb`
   - loads the base roads GeoJSON
   - stores roads in PostGIS with spatial indexes
   - exports a full-road preview map

2. `osm-sri-lanka-data-extractor.ipynb`
   - reads OSM roads from a GeoPackage
   - filters drivable roads
   - samples elevation from a DEM
   - computes road speed, travel time, and hospital-accessibility surfaces
   - exports multi-resolution H3 layers and PMTiles

## Repository layout

- `data/hotosm_lka_roads_lines_geojson.geojson` — base roads file used by the database staging notebook
- `data/DS-Research-ICU-With-Latitude-Longitude.csv` — ICU hospital point dataset
- `data/datasets/osm/sri-lanka.gpkg` — OSM GeoPackage used by the extractor notebook
- `data/datasets/dem/` — place the DEM here, typically `sri-lanka-dem.tif`
- `data/datasets/sl_boundaries/` — optional boundary GeoJSON files kept for reference
- `data/processed/ui_layers/` — notebook outputs
- `data/processed/ui_layers/pmtiles/` — PMTiles outputs and the unified viewer

## Required input data

Place the inputs in these locations before running the notebooks:

- Roads for the staging notebook:
  - `data/hotosm_lka_roads_lines_geojson.geojson`
- Roads for the main extractor notebook:
  - `data/datasets/osm/sri-lanka.gpkg`
- Hospital points:
  - `data/DS-Research-ICU-With-Latitude-Longitude.csv`
- DEM:
  - `data/datasets/dem/sri-lanka-dem.tif`

The extractor notebook expects the DEM file to exist. If it is missing, elevation fields fall back to blank values and the speed model becomes less informative.

## Environment setup

### 1) Python

Use Python 3.10 or 3.11 in a virtual environment.

Install the Python packages used by the notebooks:

- geopandas
- pandas
- numpy
- shapely
- pyproj
- pyogrio
- rasterio
- folium
- h3
- sqlalchemy
- psycopg2-binary
- scikit-learn
- jupyter

### 2) System dependencies

Install the geospatial and database tools used by the notebooks:

- PostgreSQL
- PostGIS
- pgRouting
- GDAL
- tippecanoe
- pmtiles CLI
- Docker, if you want the notebook to use container fallbacks for tippecanoe, GDAL, or pmtiles

If you prefer containerized tooling, Docker is enough for the PMTiles block because the notebook can fall back to container images automatically.

## Database setup

The staging notebook uses these default database settings:

- host: `localhost`
- port: `5432`
- database: `gis`
- user: `postgres`
- password: `postgres`

Create the database and make sure PostGIS and pgRouting are enabled before running the notebook.

## How to run the pipeline

Run the notebooks from the repository root.

### Stage 1: Road database and preview

Open `map-data-builder.ipynb` and run it top to bottom.

This notebook:

- reads the roads GeoJSON from `data/hotosm_lka_roads_lines_geojson.geojson`
- filters invalid or empty geometries
- writes the roads to PostGIS
- creates a GiST index on geometry
- adds a highway index
- saves a GeoJSON copy in `data/processed/`
- writes a Folium preview HTML map

### Stage 2: Main Sri Lanka accessibility pipeline

Open `osm-sri-lanka-data-extractor.ipynb` and run it top to bottom.

This notebook:

- reads roads from `data/datasets/osm/sri-lanka.gpkg`
- discovers the relevant OSM layers
- filters out non-drivable road classes
- reads hospital coordinates from `data/DS-Research-ICU-With-Latitude-Longitude.csv`
- samples elevation from `data/datasets/dem/sri-lanka-dem.tif`
- generates H3 speed surfaces and travel-time heatmaps
- exports PMTiles packages for browser rendering
- writes preview HTML files for quick validation

## Main outputs

The pipeline writes its outputs to `data/processed/ui_layers/`.

Important files include:

- `roads_considered.geojson`
- `roads_elevation_inputs.geojson`
- `icu_hospitals.geojson`
- `hex_speed_raw_res8.geojson`
- `hex_speed_knn_res8.geojson`
- `h3_heatmap_raw_res6.geojson`
- `h3_heatmap_raw_res7.geojson`
- `h3_heatmap_raw_res8.geojson`
- `h3_heatmap_knn_res6.geojson`
- `h3_heatmap_knn_res7.geojson`
- `h3_heatmap_knn_res8.geojson`
- `preview_heatmap_raw.html`
- `preview_heatmap_knn.html`
- `web_layers_manifest.json`
- `pmtiles/roads.pmtiles`
- `pmtiles/hospitals.pmtiles`
- `pmtiles/heatmap_raw.pmtiles`
- `pmtiles/heatmap_knn.pmtiles`
- `pmtiles/terrain_rgb.pmtiles`
- `pmtiles/contours.pmtiles`
- `pmtiles/pmtiles_manifest.json`
- `pmtiles/pmtiles_unified_viewer.html`

## Notes for research use

- The accessibility surface is a model, not a shortest-path network solve.
- Road speeds are derived from road class and then adjusted by elevation grade.
- Hospital travel time uses a detour factor to approximate road network distance from straight-line distance.
- Multi-resolution H3 layers are used so the map stays readable at country, regional, and local zoom levels.

See `PROCESS.md` for the full methodological description.
