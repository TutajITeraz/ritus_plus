import os
import numpy as np
import cv2
from PIL import Image as PILImage
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
import logging
from copy import deepcopy
from kraken.containers import BaselineLine
from shapely.geometry import Polygon, box

# Configure logging
logger = logging.getLogger(__name__)

def rgb_to_hsl(rgb):
    """
    Convert an RGB image (NumPy array) to HSL.
    
    Args:
        rgb: NumPy array of shape (height, width, 3) with values in [0, 255].
    
    Returns:
        hsl: NumPy array of shape (height, width, 3) with H, S, L in [0, 1].
    """
    rgb = rgb.astype(float) / 255.0
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    
    cmax = np.max(rgb, axis=2)
    cmin = np.min(rgb, axis=2)
    delta = cmax - cmin
    
    l = (cmax + cmin) / 2.0
    
    s = np.zeros_like(l)
    mask = cmax != cmin
    s[mask] = delta[mask] / (1.0 - np.abs(2.0 * l[mask] - 1.0))
    s[~mask] = 0
    
    h = np.zeros_like(l)
    h[delta == 0] = 0  # Set hue to 0 where delta is 0 to avoid division by zero
    mask_r = (cmax == r) & (delta > 0)
    mask_g = (cmax == g) & (delta > 0)
    mask_b = (cmax == b) & (delta > 0)
    
    h[mask_r] = (60 * ((g - b) / delta))[mask_r] % 360
    h[mask_g] = (60 * ((b - r) / delta + 2))[mask_g]
    h[mask_b] = (60 * ((r - g) / delta + 4))[mask_b]
    
    h = h / 360.0
    return np.stack([h, s, l], axis=2)

def hsl_to_rgb(hsl):
    """
    Convert an HSL image (NumPy array) to RGB.
    
    Args:
        hsl: NumPy array of shape (height, width, 3) with H, S, L in [0, 1].
    
    Returns:
        rgb: NumPy array of shape (height, width, 3) with values in [0, 255].
    """
    h, s, l = hsl[:, :, 0], hsl[:, :, 1], hsl[:, :, 2]
    h = h * 360
    
    c = (1 - np.abs(2 * l - 1)) * s
    x = c * (1 - np.abs((h / 60) % 2 - 1))
    m = l - c / 2
    
    rgb = np.zeros_like(hsl)
    
    for i in range(h.shape[0]):
        for j in range(h.shape[1]):
            h_ij = h[i, j]
            c_ij = c[i, j]
            x_ij = x[i, j]
            m_ij = m[i, j]
            
            if 0 <= h_ij < 60:
                r, g, b = c_ij, x_ij, 0
            elif 60 <= h_ij < 120:
                r, g, b = x_ij, c_ij, 0
            elif 120 <= h_ij < 180:
                r, g, b = 0, c_ij, x_ij
            elif 180 <= h_ij < 240:
                r, g, b = 0, x_ij, c_ij
            elif 240 <= h_ij < 300:
                r, g, b = x_ij, 0, c_ij
            else:
                r, g, b = c_ij, 0, x_ij
                
            rgb[i, j] = np.array([r, g, b]) + m_ij
    
    return (rgb * 255).astype(np.uint8)

def split_line_boundary_by_color(color_image, line, line_index, debug_dir, window_size=80, red_threshold=2):
    """
    Crop, preprocess with polygon mask, split line into red/black segments based on redness,
    and generate images with baseline/boundary outlines and a histogram plot.
    
    Args:
        color_image: PIL Image in original color mode (e.g., RGB).
        line: BaselineLine object with boundary and baseline coordinates.
        line_index: Index of the line (for naming output files).
        debug_dir: Directory to save images and histogram plot.
        window_size: Size of the moving average window for denoising (default: 80).
        red_threshold: Threshold for redness score to split lines (default: 10).
    
    Returns:
        List of new BaselineLine objects with cropped coordinates and added 'color' attribute.
    """
    if not hasattr(line, 'boundary') or not line.boundary or len(line.boundary) < 3:
        logger.warning(f"No valid boundary found for line {line_index + 1}, skipping image save and analysis")
        # Save debug image with original boundary

    
        # color_array = np.array(color_image)
        # debug_image = cv2.cvtColor(color_array, cv2.COLOR_RGB2BGR)
        # if line.boundary:
        #     orig_boundary = np.array(line.boundary, dtype=np.int32)
        #     cv2.polylines(debug_image, [orig_boundary], True, (0, 0, 0), 1)
        # debug_image_pil = PILImage.fromarray(cv2.cvtColor(debug_image, cv2.COLOR_BGR2RGB))
        # debug_image_path = os.path.join(debug_dir, f"line_{line_index + 1}_debug.png")
        # debug_image_pil.save(debug_image_path)
        
        logger.info(f"Saved debug image for line {line_index + 1} to {debug_image_path}")
        return [line]
    
    # Derive bounding box from boundary coordinates
    x_coords, y_coords = zip(*line.boundary)
    padding = 10
    left = max(0, min(x_coords) - padding)
    top = max(0, min(y_coords) - padding)
    right = min(color_image.width, max(x_coords) + padding)
    bottom = min(color_image.height, max(y_coords) + padding)

    # Crop the image around the boundary
    # Crop the image around the boundary
    cropped_image = color_image.crop((left, top, right, bottom))
    color_array = np.array(cropped_image)
    height, width = color_array.shape[:2]
    logger.debug(f"Cropped image for line {line_index + 1}: width={width}, height={height}")

    # Create polygon mask in cropped image coordinates
    mask = np.zeros((height, width), dtype=np.uint8)
    shifted_boundary = [(x - left, y - top) for x, y in line.boundary]
    shifted_boundary = np.array(shifted_boundary, dtype=np.int32)

    # Ensure polygon is valid and within bounds
    if len(shifted_boundary) >= 3:
        cv2.fillPoly(mask, [shifted_boundary], 255)
    else:
        logger.warning(f"Invalid boundary for line {line_index + 1}, using full cropped image")
        mask[:] = 255

    # Apply mask: keep pixels inside polygon, set others to gray (128, 128, 128)
    gray = np.array([128, 128, 128], dtype=np.uint8)
    masked_image = color_array.copy()
    masked_image[mask == 0] = gray

    # Apply light Gaussian blur to reduce noise
    #denoised = cv2.GaussianBlur(masked_image, (3, 3), 0)
    denoised = masked_image

    # Convert to HSL
    hsl_array = rgb_to_hsl(denoised)

    # Apply CLAHE to the lightness channel
    h, s, l = hsl_array[:, :, 0], hsl_array[:, :, 1], hsl_array[:, :, 2]
    l_scaled = (l * 255).astype(np.uint8)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_enhanced = clahe.apply(l_scaled)
    l_enhanced = l_enhanced.astype(float) / 255.0

    # Merge back and convert to RGB
    hsl_enhanced = np.stack([h, s, l_enhanced], axis=2)
    #enhanced_array = hsl_to_rgb(hsl_enhanced)

    #SIMPLER, FASTER:
    #hsl_enhanced = masked_image

    # Convert to PIL image for saving
    #enhanced_image = PILImage.fromarray(enhanced_array)

    #SIMPLER, FASTER:
    #enhanced_image = masked_image

    # enhanced_array_cv = cv2.cvtColor(np.array(enhanced_image), cv2.COLOR_RGB2BGR)

    # Save enhanced image
    image_path = os.path.join(debug_dir, f"line_{line_index + 1}.png")
    #enhanced_image.save(image_path)
    logger.info(f"Saved enhanced color image for line {line_index + 1} to {image_path}")

    # Verify hsl_enhanced dimensions
    hues, saturations, lightnesses = hsl_enhanced[:, :, 0], hsl_enhanced[:, :, 1], hsl_enhanced[:, :, 2]
    enhanced_height, enhanced_width = hsl_enhanced.shape[:2]
    if enhanced_width != width:
        logger.warning(f"Dimension mismatch for line {line_index + 1}: cropped width={width}, hsl_enhanced width={enhanced_width}")
        width = enhanced_width  # Use actual width from hsl_enhanced
    logger.debug(f"hsl_enhanced for line {line_index + 1}: width={width}, height={enhanced_height}")

    # Initialize lists for histogram data
    redness_scores = []
    peak_saturations = []

    # Analyze each column (x-axis)
    for x in range(width):
        try:
            column_h = hues[:, x]
            column_s = saturations[:, x]
            column_l = lightnesses[:, x]

            # Redness score based on hue, saturation, and lightness distances
            sigma_h = 0.05
            sigma_l = 0.15
            sigma_s = 0.2

            # Hue: Distance to nearest red (0.0 or 1.0)
            hue_distance = np.minimum(np.abs(column_h), np.abs(column_h - 1))
            hue_mask = (column_h <= 0.1) | (column_h >= 0.91)
            hue_weight = np.where(hue_mask, np.exp(-(hue_distance ** 2) / (2 * sigma_h ** 2)), 0)

            # Lightness: Distance to 0.5, within [0.25, 0.8]
            lightness_mask = (column_l >= 0.25) & (column_l <= 0.8)
            lightness_distance = np.abs(column_l - 0.5)
            lightness_weight = np.where(lightness_mask, np.exp(-(lightness_distance ** 2) / (2 * sigma_l ** 2)), 0)

            # Saturation: Distance to 1.0, within [0.3, 1.0]
            saturation_mask = (column_s >= 0.3) & (column_s <= 1.0)
            saturation_distance = np.abs(column_s - 1.0)
            saturation_weight = np.where(saturation_mask, np.exp(-(saturation_distance ** 2) / (2 * sigma_s ** 2)), 0)

            # Redness score: Multiply weights and scale
            redness = hue_weight * lightness_weight * saturation_weight * 100

            # Average redness score for the column
            avg_redness = np.mean(redness) * 100 if column_h.size > 0 else 0
            peak_saturation = np.max(column_s) if column_s.size > 0 else 0

            redness_scores.append(float(avg_redness))
            peak_saturations.append(float(peak_saturation))
        except Exception as e:
            logger.warning(f"Error processing column {x} for line {line_index + 1}: {str(e)}")
            redness_scores.append(0.0)
            peak_saturations.append(0.0)

    # Ensure arrays match width
    if len(redness_scores) != width or len(peak_saturations) != width:
        logger.warning(f"Dimension mismatch for line {line_index + 1}: redness_scores={len(redness_scores)}, peak_saturations={len(peak_saturations)}, width={width}")
        while len(redness_scores) < width:
            redness_scores.append(0.0)
        while len(peak_saturations) < width:
            peak_saturations.append(0.0)
        redness_scores = redness_scores[:width]
        peak_saturations = peak_saturations[:width]

    # Denoise redness scores with moving average
    kernel = np.ones(min(window_size, width)) / min(window_size, width)  # Adjust window_size if width is smaller
    denoised_redness = np.convolve(redness_scores, kernel, mode='same')

    # Create histogram plot
    #fig, ax1 = plt.subplots(figsize=(8, 4))
    # ax1.bar(range(width), redness_scores, color='red', alpha=0.3, label='Original Redness')
    # ax1.plot(range(width), denoised_redness, color='green', linewidth=2, label='Denoised Redness')
    # ax1.set_xlabel('Column (x-axis)')
    # ax1.set_ylabel('Redness Score', color='red')
    # ax1.tick_params(axis='y', labelcolor='red')
    # ax1.set_xlim(0, width)
    # ax1.set_ylim(0, max(100, max(redness_scores, default=0) + 10))
    # ax1.legend(loc='upper left')

    # # Secondary axis for peak saturation
    # ax2 = ax1.twinx()
    # ax2.plot(range(width), peak_saturations, color='blue', linestyle='--', label='Peak Saturation')
    # ax2.set_ylabel('Peak Saturation', color='blue')
    # ax2.tick_params(axis='y', labelcolor='blue')
    # ax2.set_ylim(0, 1)
    # ax2.legend(loc='upper right')

    # Identify regions based on denoised redness threshold
    regions = []
    current_region = {'start': None, 'above_threshold': None}
    for x in range(width):
        above_threshold = denoised_redness[x] >= red_threshold
        if current_region['start'] is None:
            current_region = {'start': x, 'above_threshold': above_threshold}
        elif current_region['above_threshold'] != above_threshold:
            # Ensure region is at least 5 pixels wide to avoid Kraken error
            if x - current_region['start'] >= 5:
                regions.append(current_region)
            else:
                logger.debug(f"Skipping narrow region for line {line_index + 1}: {current_region['start']} to {x}")
            current_region = {'start': x, 'above_threshold': above_threshold}
    if current_region['start'] is not None and width - current_region['start'] >= 5:
        regions.append(current_region)
    elif current_region['start'] is not None:
        logger.debug(f"Skipping narrow final region for line {line_index + 1}: {current_region['start']} to {width}")

    # Plot rectangular outlines for regions
    # for region in regions:
        # start = region['start']
        # end = width if region is regions[-1] else regions[regions.index(region) + 1]['start']
        # color = 'red' if region['above_threshold'] else 'black'
        # rect = Rectangle((start, 0), end - start, ax1.get_ylim()[1], 
        #                  fill=False, edgecolor=color, linewidth=1.5)
        # ax1.add_patch(rect)

    #plt.title(f'Line {line_index + 1} Redness Score and Peak Saturation')
    #plt.tight_layout()

    # Save histogram plot
    #histogram_path = os.path.join(debug_dir, f"line_{line_index + 1}_histogram.png")
    #plt.savefig(histogram_path)
    #plt.close()
    #logger.info(f"Saved histogram plot for line {line_index + 1} to {histogram_path}")

    # Convert original boundary to cropped coordinates for intersection
    cropped_boundary = [(x - left, y - top) for x, y in line.boundary]
    orig_boundary_polygon = Polygon(cropped_boundary) if len(cropped_boundary) >= 3 else None

    # Initialize debug image
    # debug_image = enhanced_array_cv.copy()
    new_lines = []

    # Draw original boundary for debugging
    #if orig_boundary_polygon:
    #    cv2.polylines(debug_image, [shifted_boundary], True, (128, 128, 128), 1)

    for idx, region in enumerate(regions):
        start_x_crop = region['start']
        end_x_crop = width if region is regions[-1] else regions[regions.index(region) + 1]['start']
        color = "red" if region['above_threshold'] else "black"
        logger.debug(f"Processing region {idx} for line {line_index + 1}, color {color}, x-range: {start_x_crop} to {end_x_crop}")

        # Create a full-height rectangular box in cropped coordinates
        rect_box = box(start_x_crop, 0, end_x_crop, height)

        # Intersect with original boundary
        if orig_boundary_polygon and orig_boundary_polygon.is_valid:
            try:
                # Buffer slightly to fix degenerate cases
                buffered_polygon = orig_boundary_polygon.buffer(0.01, resolution=1)
                intersection = buffered_polygon.intersection(rect_box)
                if intersection.is_empty or not intersection.is_valid:
                    logger.warning(f"Intersection empty or invalid for line {line_index + 1}, region {idx}, color {color}")
                    new_boundary_crop = [
                        (start_x_crop, 0),
                        (start_x_crop, height),
                        (end_x_crop, height),
                        (end_x_crop, 0)
                    ]
                else:
                    # Handle Polygon or MultiPolygon
                    if isinstance(intersection, Polygon):
                        new_boundary_crop = list(intersection.exterior.coords)[:-1]
                    else:
                        logger.warning(f"Non-polygon intersection for line {line_index + 1}, region {idx}, color {color}")
                        new_boundary_crop = [
                            (start_x_crop, 0),
                            (start_x_crop, height),
                            (end_x_crop, height),
                            (end_x_crop, 0)
                        ]
            except Exception as e:
                logger.warning(f"Intersection failed for line {line_index + 1}, region {idx}, color {color}: {str(e)}")
                new_boundary_crop = [
                    (start_x_crop, 0),
                    (start_x_crop, height),
                    (end_x_crop, height),
                    (end_x_crop, 0)
                ]
        else:
            logger.warning(f"Invalid original boundary for line {line_index + 1}, region {idx}, color {color}")
            new_boundary_crop = [
                (start_x_crop, 0),
                (start_x_crop, height),
                (end_x_crop, height),
                (end_x_crop, 0)
            ]

        # Interpolate baseline in cropped coordinates
        new_baseline_crop = []
        baseline_x, baseline_y = zip(*line.baseline) if line.baseline else ([], [])
        for i in range(len(baseline_x)):
            x = baseline_x[i] - left
            y = baseline_y[i] - top
            if start_x_crop <= x < end_x_crop:
                new_baseline_crop.append((x, y))
            elif i < len(baseline_x) - 1:
                x_next = baseline_x[i + 1] - left
                y_next = baseline_y[i + 1] - top
                if (x < start_x_crop <= x_next) or (x < end_x_crop <= x_next):
                    t = (start_x_crop - x) / (x_next - x) if x_next != x else 0
                    y_interp = y + t * (y_next - y)
                    new_baseline_crop.append((start_x_crop, y_interp))
                if (start_x_crop <= x < end_x_crop) and (x_next >= end_x_crop):
                    t = (end_x_crop - x) / (x_next - x) if x_next != x else 0
                    y_interp = y + t * (y_next - y)
                    new_baseline_crop.append((end_x_crop, y_interp))

        # Ensure baseline is at least 5 pixels wide
        if new_baseline_crop:
            min_x = min(x for x, y in new_baseline_crop)
            max_x = max(x for x, y in new_baseline_crop)
            if max_x - min_x < 5:
                logger.debug(f"Extending baseline for line {line_index + 1}, region {idx}, color {color}")
                mid_y = sum(y for x, y in new_baseline_crop) / len(new_baseline_crop) if new_baseline_crop else (height / 2)
                new_baseline_crop = [(start_x_crop, mid_y), (end_x_crop, mid_y)]
        else:
            logger.debug(f"No baseline points for line {line_index + 1}, region {idx}, color {color}, creating default")
            mid_y = height / 2
            new_baseline_crop = [(start_x_crop, mid_y), (end_x_crop, mid_y)]

        # Draw baseline and boundary on debug image
        color_bgr = (0, 0, 255) if color == "red" else (0, 0, 0)
        if new_baseline_crop:
            baseline_pts = np.array(new_baseline_crop, dtype=np.int32)
            #cv2.polylines(debug_image, [baseline_pts], False, color_bgr, 1)
        if new_boundary_crop:
            boundary_pts = np.array(new_boundary_crop, dtype=np.int32)
            #cv2.polylines(debug_image, [boundary_pts], True, color_bgr, 1)

        # Map back to original coordinates for BaselineLine
        new_baseline_orig = [(x + left, y + top) for x, y in new_baseline_crop]
        new_boundary_orig = [(x + left, y + top) for x, y in new_boundary_crop]

        # Clip coordinates to image bounds
        width, height = color_image.size
        new_baseline_orig = [(max(0, min(width - 1, x)), max(0, min(height - 1, y))) for x, y in new_baseline_orig]
        new_boundary_orig = [(max(0, min(width - 1, x)), max(0, min(height - 1, y))) for x, y in new_boundary_orig]

        # Create new BaselineLine object
        if new_baseline_orig and new_boundary_orig:
            new_line = BaselineLine(
                id=f"{line_index + 1}_{idx}",
                baseline=new_baseline_orig,
                boundary=new_boundary_orig,
                tags=deepcopy(line.tags) if hasattr(line, 'tags') else {},
                regions=deepcopy(line.regions) if hasattr(line, 'regions') else [],
                text=line.text if hasattr(line, 'text') else None,
                imagename=line.imagename if hasattr(line, 'imagename') else None,
                base_dir=line.base_dir if hasattr(line, 'base_dir') else None,
                split=line.split if hasattr(line, 'split') else None,
                type=line.type if hasattr(line, 'type') else 'baselines'
            )
            new_line.color = color
            new_line.segmentation_type = getattr(line, 'segmentation_type', 'baselines')
            new_lines.append(new_line)
            logger.debug(f"Created new line {new_line.id}, color {color}, baseline length={max(x for x, y in new_baseline_orig) - min(x for x, y in new_baseline_orig) if new_baseline_orig else 0}")

    # Save debug image with outlines
    #debug_image_pil = PILImage.fromarray(cv2.cvtColor(debug_image, cv2.COLOR_BGR2RGB))
    #debug_image_path = os.path.join(debug_dir, f"line_{line_index + 1}_debug.png")
    #debug_image_pil.save(debug_image_path)
    #logger.info(f"Saved debug image with outlines for line {line_index + 1} to {debug_image_path}")

    return new_lines if new_lines else [line]