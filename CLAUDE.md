# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a React-based web application called "Bill Splitter" that helps users split bills by uploading receipt images or manual entry. The app combines OCR (Optical Character Recognition), YOLO-based machine learning for automatic receipt cropping, and manual bill splitting functionality.

## Key Technologies

- **Frontend**: React 19 with Vite as build tool
- **Styling**: Pico CSS framework + Tailwind CSS
- **OCR**: Tesseract.js for text extraction from images
- **ML/AI**: TensorFlow.js for YOLO object detection model, OpenAI GPT-4 for text cleanup
- **Image Processing**: react-image-crop and react-easy-crop for manual cropping
- **Routing**: React Router DOM

## Architecture

### Core Components

1. **App.jsx** (src/App.jsx) - Main application with routing and three primary modes:
   - Home page with navigation options
   - Manual bill splitting mode
   - OCR-based bill splitting mode (with optional auto-crop)

2. **ImageCropper.jsx** (src/ImageCropper.jsx) - Manual image cropping component with preprocessing (grayscale conversion and contrast enhancement)

### Application Flow

1. **Auto-crop Flow**: Upload → YOLO model detects receipt region → Auto-crop → OCR → LLM cleanup → Manual editing → Bill splitting
2. **Manual OCR Flow**: Upload → Manual crop → OCR → LLM cleanup → Manual editing → Bill splitting  
3. **Manual Entry Flow**: Direct manual entry of bill items and diners

### YOLO Model Integration

- Pre-trained YOLO model stored in `public/best_web_model/` (model.json + weight shards)
- Input preprocessing: resize to 640x640, normalize to [0,1]
- Handles various YOLO output formats ([batch, detections, features] or [batch, features, detections])
- Confidence threshold: 0.3
- Adds 5% padding around detected receipt region

### Data Structure

The app maintains consistent data structures across modes:
- **Diners**: Array of strings (names)
- **Items**: Array of objects with {name, price, sharedBy: [indices]}
- **Tax calculations**: Service charge multiplier + GST percentage

## Development Commands

```bash
# Development server
npm run dev

# Build for production  
npm run build

# Preview production build
npm run preview

# Lint code
npm run lint
```

## External Dependencies

- **OpenAI API**: Requires VITE_OPENAI_API_KEY environment variable for LLM text cleanup
- **YOLO Model**: Receipt detection model files must be present in public/best_web_model/

## Dataset Structure

The repository includes YOLO training data:
- `train/`, `valid/`, `test/` directories with images and corresponding label files
- `data.yaml` defines the dataset configuration for 'bill_region' class
- Dataset sourced from Roboflow (receipt-autocrop project)

## Key Features

1. **Automatic Receipt Detection**: YOLO-based receipt boundary detection
2. **OCR Processing**: Tesseract.js extracts text from cropped images
3. **LLM Enhancement**: GPT-4 cleans and structures OCR output into itemized bills
4. **Flexible Bill Splitting**: Support for service charges, GST, and per-item diner assignment
5. **Export Functionality**: Copy bill summaries to clipboard as tab-separated text