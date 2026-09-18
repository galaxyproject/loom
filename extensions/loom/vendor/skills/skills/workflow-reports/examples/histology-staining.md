# Example: Histological Staining Area Quantification

A complete worked example of applying the workflow-reports skill to a real imaging analysis workflow.

## Workflow Metadata

| Field | Value |
|-------|-------|
| Name | histology-stain-area-quantification |
| Instance | usegalaxy.eu |
| ID | `e429074ee0a47cb3` |
| Download URL | `https://usegalaxy.eu/api/workflows/e429074ee0a47cb3/download?style=editor` |
| Purpose | Quantify staining area in brightfield histological images using colour deconvolution and automated thresholding |
| Compatible stainings | IHC (DAB chromogen), Masson's Trichrome |

## Extracted Data

### Inputs

| Step | Label | Type | Annotation |
|------|-------|------|-----------|
| 0 | `ROI image for staining analysis` | `data_collection_input` | Brightfield TIFF images, RGB, one ROI per element |

### Workflow Outputs

| Step | Step label | Output label | Type |
|------|-----------|--------------|------|
| 3 | `Color Deconvolution` | `Deconvolved Image` | Multi-channel image |
| 5 | `Split Image Channels for Staining Detection` | `Collection: Individual Deconvolved Channels` | Image collection |
| 8 | `Collection: Extract Stain Channel from Sub-Collections` | `Selected Stain Channel` | Image collection |
| 11 | `Threshold Stain Channel Collection` | `Selected Stain Channel Thresholded` | Image collection (binary mask) |
| 13 | `Extract Image Features` | `Collection of Tabular: Staining Quantification Results` | Tabular collection |
| 25 | `Tabular: Staining Feature Results` | `Tabular File: Staining Feature Results` | Tabular (TSV) |

**Note:** Step 27 (`Percent area computation`) computes the `percent_area` column but its output is **not marked as a workflow output**. The marked output (`Tabular File: Staining Feature Results`, step 25) is the pre-percent-area table. To include `percent_area` in the embedded table, the step 27 output must be starred in the Workflow Editor.

### Key Step Labels (for `job_parameters`)

- `Color Deconvolution`
- `Threshold Stain Channel Collection`
- `Extract Image Features`

### Output Columns (`Tabular File: Staining Feature Results`)

| Column | Description |
|--------|-------------|
| `sample_id` | Identifier derived from the input image filename |
| `label` | Region label assigned by the thresholding step |
| `mean_intensity` | Average pixel intensity within the detected region |
| `area` | Pixel count of the positively stained region |
| `area_filled` | Stained area with internal holes filled |

---

## Resulting Report Template

````markdown
# Histological Staining Area Quantification

```galaxy
invocation_time()
```

---

## Summary

This workflow is designed to quantify the area and intensity of a specific stain in brightfield
histological images. It takes a collection of input images, applies H-E-DAB colour deconvolution
to separate the target stain channel from the haematoxylin counterstain, then uses automated
thresholding to segment positive-staining pixels. Per-sample measurements are collated into a
single tabular output.

Compatible staining types include immunohistochemistry (IHC) with a DAB chromogen and Masson's
Trichrome (MT). The workflow expects RGB TIFF images — one region of interest (ROI) per
collection element.

```galaxy
workflow_image()
```

---

## Input Images

The input to this workflow is a list collection of brightfield microscopy images. Each element
should represent one region of interest from a tissue section. The images provided for this
run are shown below.

```galaxy
history_dataset_as_image(input="ROI image for staining analysis")
```

---

## Staining Mask

If the run completed successfully, each input image will have been converted into a binary mask
via colour deconvolution and automated thresholding. In a successful run, white pixels represent
regions classified as positively stained and black pixels represent background. This mask is
what the quantification measurements are derived from.

```galaxy
history_dataset_as_image(output="Selected Stain Channel Thresholded")
```

---

## Results

If the workflow completed successfully, the table below shows per-sample staining measurements —
one row per input image. The expected columns are described below.

| Column | Description |
|--------|-------------|
| `sample_id` | Identifier derived from the input image filename |
| `label` | Region label assigned by the thresholding step |
| `mean_intensity` | Average pixel intensity within the detected region |
| `area` | Pixel count of the positively stained region |
| `area_filled` | Stained area with internal holes filled |

```galaxy
history_dataset_as_table(output="Tabular File: Staining Feature Results", title="Staining Feature Results", show_column_headers=true, compact=true)
```

```galaxy
history_dataset_link(output="Tabular File: Staining Feature Results", label="Download results (TSV)")
```

---

## Reproducibility

```galaxy
history_link()
```
````

---

## Notes

- The `history_dataset_as_image` directive works for both single images and collections — no special handling needed.
- `Selected Stain Channel Thresholded` was chosen over `Deconvolved Image` or `Selected Stain Channel` as the primary visual output because it directly represents what the quantification is based on.
- The Methods / `job_parameters` blocks were omitted from this template to keep it focused. They can be added as collapsible sections for workflows where parameter choices significantly affect interpretation.
