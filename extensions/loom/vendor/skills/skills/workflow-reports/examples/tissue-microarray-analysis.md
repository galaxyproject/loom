# Example: End-to-End Tissue Microarray Analysis

A complete worked example of applying the workflow-reports skill to a multiplex tissue image analysis pipeline.

## Workflow Metadata

| Field | Value |
|-------|-------|
| Name | End-to-End Tissue Microarray Analysis |
| Source | `.ga` file |
| Path | `workflows/imaging/tissue-microarray-analysis/tissue-microarray-analysis/tissue-micro-array-analysis.ga` |
| Purpose | Complete MTI analysis pipeline for TMA data: illumination correction, stitching, dearray, segmentation, quantification, phenotyping, and interactive visualisation |

## Extracted Data

### Inputs

| Step | Label | Type |
|------|-------|------|
| 0 | `Raw cycle images` | `data_collection_input` (list of TIFF/OME-TIFF, ordered by cycle) |
| 1 | `markers.csv` | `data_input` (CSV with columns: round, channel, marker_name) |
| 2 | `PhenotypeWorkflow` | `data_input` (Scimap-formatted phenotype workflow CSV) |

### Workflow Outputs

| Step | Step label | Output label | Selected for report |
|------|-----------|--------------|---------------------|
| 3 | `Illumination correction with Basic` | `DFP images`, `FFP images` | No — early intermediates |
| 4 | `Stitching and registration with Ashlar` | `Registered image` | No — intermediate |
| 5 | `TMA dearray with UNetCoreograph` | `Dearray images`, `Dearray masks`, `TMA dearray map` | `TMA dearray map` only — most informative for verifying dearray |
| 6 | `Nuclear segmentation` | `Nuclear mask` | Yes — direct basis for quantification |
| 7 | `Convert dearray images to OME-TIFF` | `Converted image` | No — format conversion intermediate |
| 8 | `Cell feature quantification with MC-Quant` | `Primary Mask Quantification` | Yes — primary quantitative result |
| 9 | `Rename OME-TIFF channels` | `Renamed image` | No — intermediate |
| 10 | `Convert to Anndata` | `Anndata feature table` | No — superseded by phenotyped output |
| 11 | `Scimap phenotyping` | `Phenotyped feature table` | Yes — enriched final result |
| 12 | `Create a Vitessce dashboard` | `Vitessce dashboard`, `Vitessce Dashboard Config` | `Vitessce dashboard` only — config is auxiliary |

### Step Labels Available for `job_parameters`

All steps have labels. Key ones used: `Nuclear segmentation`.

---

## Resulting Report Template

````markdown
# End-to-End Tissue Microarray Analysis

```galaxy
invocation_time()
```

## Summary

This workflow is designed to perform a complete multiplex tissue image (MTI) analysis pipeline
for tissue microarray (TMA) data imaged using cyclic immunofluorescence. It expects a
round-ordered collection of raw cycle images (TIFF or OME-TIFF), a CSV markers file with
channel names in the third column, and a Scimap-formatted phenotype workflow file.

Starting from raw images, the pipeline applies illumination correction (BaSiC), stitches and
registers cycles into a single whole-slide OME-TIFF (ASHLAR), and segments TMA cores into
individual image crops (UNetCoreograph). Each core image then undergoes nuclear segmentation
(Mesmer), per-cell feature quantification (MCQUANT), cell phenotyping (Scimap), and interactive
visualisation (Vitessce). If the run completes successfully, it should produce pyramidal
OME-TIFF images, nuclear segmentation masks, a quantified feature table, a phenotype-annotated
AnnData object, and an interactive Vitessce dashboard.

```galaxy
workflow_image()
```

## Inputs

The workflow expects three inputs:

- **Raw cycle images** — a list collection of raw fluorescence cycle images (TIFF or OME-TIFF)
  ordered by acquisition cycle (e.g. `cycle_1.tiff`, `cycle_2.tiff`, ...).
- **markers.csv** — a comma-separated file with columns `round`, `channel`, and `marker_name`.
  The marker names in the third column are assigned as channel names during stitching.
- **PhenotypeWorkflow** — a Scimap-formatted phenotype workflow CSV that maps hierarchical
  cell phenotypes to marker combinations.

```galaxy
invocation_inputs()
```

## TMA Dearray Map

After stitching and registration, UNetCoreograph segments individual TMA cores and produces a
map image showing the detected core positions overlaid on the whole-slide image. If dearray
completed successfully, this image should show each TMA core outlined or labelled within the
tissue array. It is useful for verifying that the expected number of cores was detected and
that core boundaries are correct before proceeding with per-core batch analysis.

```galaxy
history_dataset_as_image(output="TMA dearray map")
```

## Nuclear Segmentation Masks

Mesmer performs nuclear segmentation on each dearrayed core image and produces a collection of
labelled nuclear mask TIFFs. If segmentation completed successfully, each mask should show
individual nuclei as distinct integer-labelled regions against a black background — each unique
integer corresponds to one segmented nucleus. These masks are the basis for cell boundary
delineation used in feature quantification.

```galaxy
history_dataset_as_image(output="Nuclear mask")
```

```galaxy
job_parameters(step="Nuclear segmentation", collapse="Show nuclear segmentation parameters")
```

## Cell Feature Quantification

MCQUANT quantifies per-cell features from each core image using the nuclear masks, producing a
CSV table where each row represents one segmented cell and columns contain mean marker
intensities, spatial coordinates, and morphological measurements.

| Column | Description |
|--------|-------------|
| `CellID` | Unique integer identifier for each segmented cell |
| `X_centroid` | X coordinate of the cell centroid in pixels |
| `Y_centroid` | Y coordinate of the cell centroid in pixels |
| `<marker>_mean` | Mean fluorescence intensity of the named marker channel within the cell mask |
| `Area` | Area of the segmented cell nucleus in pixels |
| `MajorAxisLength` | Length of the major axis of the fitted ellipse |
| `MinorAxisLength` | Length of the minor axis of the fitted ellipse |
| `Eccentricity` | Eccentricity of the fitted ellipse (0 = circle, 1 = line) |
| `Solidity` | Ratio of cell area to convex hull area |
| `Extent` | Ratio of cell area to bounding box area |
| `Orientation` | Angle of the major axis relative to the x-axis |

```galaxy
history_dataset_as_table(output="Primary Mask Quantification", show_column_headers=true, compact=true)
```

```galaxy
history_dataset_link(output="Primary Mask Quantification", label="Download quantification table (CSV)")
```

## Phenotyped Feature Table

Scimap performs automated GMM-based cell phenotyping using the provided phenotype workflow and
appends cell type annotations to the quantification data. The output is an AnnData (h5ad)
object compatible with single-cell and spatial analysis packages. Note that GMM-based
thresholding works best for highly abundant markers with a strong bimodal distribution;
results should be reviewed carefully before downstream interpretation.

```galaxy
history_dataset_link(output="Phenotyped feature table", label="Download phenotyped AnnData (h5ad)")
```

## Interactive Vitessce Dashboard

Vitessce combines the renamed OME-TIFF core images, nuclear segmentation masks, and phenotyped
AnnData into an interactive dashboard. If the run completed successfully, the dashboard should
allow linked exploration of spatial image data alongside single-cell scatter plots and cell
type visualisations.

```galaxy
history_dataset_embedded(output="Vitessce dashboard")
```

## Reproducibility

```galaxy
history_link()
```

```galaxy
workflow_display(collapse="Show full workflow details")
```
````
