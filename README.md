
# Golden Hour Divide: Trauma Care Accessibility and Resource Vulnerability in Sri Lanka

## Overview

This repository contains the source code accompanying the research paper:

**Golden Hour Divide: Trauma Care Accessibility and Resource Vulnerability in Sri Lanka**

The project presents a reproducible computational framework for evaluating trauma care accessibility, healthcare resource vulnerability, and policy prioritization across Sri Lanka's 25 administrative districts. The methodology integrates terrain-aware accessibility modelling, healthcare infrastructure assessment, disease burden analysis, spatial vulnerability indices, and policy clustering to support evidence-based healthcare planning.

---

## Dataset

The dataset used in this study is publicly available on Hugging Face:

**https://huggingface.co/datasets/sonath0427/sri-lankan-medical-institutional-data**

The dataset contains official Sri Lankan healthcare infrastructure, demographic, and disease burden statistics for the year **2024**, compiled from:

* Annual Health Bulletin 2024
* Medical Statistics Unit, Ministry of Health, Sri Lanka

**Important:** The notebooks in this repository use **phase-specific CSV files**. These CSV files are derived from the complete dataset available on Hugging Face and are included within their respective phase folders for ease of execution.

---

# Repository Structure

```text
.
├── MapConstructing/
├── Phase1/
├── Phase2/
├── Phase3/
├── Phase4/
└── README.md
```

Each phase is self-contained and includes:

* The Google Colab notebook implementing that phase.
* The required input CSV files for that phase.
* Generated outputs such as figures and intermediate results (where applicable).

---

# Methodology

## Phase 1 – Terrain-Aware Spatial Gap Analysis

This phase estimates geographic accessibility to Intensive Care Unit (ICU) facilities across Sri Lanka.

Main tasks include:

* Processing the Sri Lankan road network
* Terrain-aware travel speed modelling
* Travel-time estimation to the nearest ICU hospital
* H3 hexagonal spatial discretisation
* K-Nearest Neighbour (KNN) interpolation
* Computation of the Spatial Gap (Gd)

**Outputs**

* Travel-time surfaces
* District accessibility metrics
* Spatial Gap (Gd)

---

## Phase 2 – Infrastructure Paradox Assessment

This phase evaluates the mismatch between emergency stabilization capacity and definitive critical care resources.

Main tasks include:

* Analysis of ICU-equipped hospitals
* Analysis of ETU-capable hospitals
* Institutional Access Ratio (IAR) calculation

**Outputs**

* Infrastructure accessibility indicators
* Institutional Access Ratio (IAR)

---

## Phase 3 – Clinical Need-Gap Index (NGI)

This phase integrates healthcare demand, accessibility, and healthcare resources to quantify district-level vulnerability.

Main tasks include:

* Resource Score calculation
* General Need-Gap Index (NGI)
* Disease-specific NGIs
* Lethality Ratio (Lr)
* Resource normalization
* Disease-specific resource weighting

Conditions analysed include:

* Ischaemic Heart Disease
* Cerebrovascular Disease
* Traumatic Injuries
* Snake Bites
* Poisoning
* Asthma
* Pneumonia

**Outputs**

* General NGI
* Disease-specific NGIs
* Resource vulnerability metrics

---

## Phase 4 – Policy Clustering and System Optimisation

The final phase identifies healthcare system archetypes and evaluates intervention strategies.

Main tasks include:

* K-Means clustering
* Territorial Coverage Ratio (TCR)
* Cluster identification
* Policy recommendation generation
* Infrastructure optimisation simulation
* NGI reduction analysis

Cluster archetypes:

* Critical Structural Exclusion
* Institutional Mirages
* Operational Capacity Strain
* High-Resilience Benchmarks

**Outputs**

* Policy clusters
* Priority intervention districts
* Optimisation simulation results

---

# Running the Project

Each phase is designed to be executed independently after the required CSV input files are available within its corresponding folder.

Recommended execution order:

1. Phase 1 – Terrain-Aware Spatial Gap
2. Phase 2 – Infrastructure Paradox
3. Phase 3 – Clinical Need-Gap Index
4. Phase 4 – Policy Clustering and System Optimisation

**Note:** Each notebook expects its required CSV input files to be located in the same phase directory. Ensure that all associated CSV files remain in their respective folders before running the notebooks.

---

# Requirements

The implementation was developed using **Python** in **Google Colab**.

Major libraries include:

* pandas
* numpy
* matplotlib
* geopandas
* networkx
* scikit-learn
* scipy
* h3
* openpyxl


---

# Citation

If you use this repository or the accompanying dataset in your research, please cite the associated conference paper.

---

# License

This repository is provided for research and educational purposes.

The original healthcare statistics remain the property of the Ministry of Health, Sri Lanka. Users should acknowledge the original data sources when using the dataset.

---

# Acknowledgements

The healthcare statistics used in this study were compiled from publicly available publications of:

* Annual Health Bulletin 2024
* Medical Statistics Unit, Ministry of Health, Sri Lanka
