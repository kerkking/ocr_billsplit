import React, { useState, useRef, useEffect } from 'react';
import ReactCrop from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

function ImageCropper({ onCrop }) {
  const [src, setSrc] = useState(null);
  const [crop, setCrop] = useState({ unit: 'px', x: 20, y: 20, width: 200, height: 200 });
  const [completedCrop, setCompletedCrop] = useState(null);
  const [croppedUrl, setCroppedUrl] = useState(null);
  const imgRef = useRef(null);
  const previewCanvasRef = useRef(null);

  const onSelectFile = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onload = () => {
        // Preprocess: convert to grayscale and increase contrast
        const img = new window.Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;
          // Grayscale and contrast
          for (let i = 0; i < data.length; i += 4) {
            // Grayscale
            const avg = (data[i] + data[i+1] + data[i+2]) / 3;
            // Contrast (simple stretch)
            const contrast = 1.5; // 1 = no change, >1 = more contrast
            const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
            const newVal = factor * (avg - 128) + 128;
            data[i] = data[i+1] = data[i+2] = Math.max(0, Math.min(255, newVal));
          }
          ctx.putImageData(imageData, 0, 0);
          setSrc(canvas.toDataURL('image/png'));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
      setCroppedUrl(null);
    }
  };

  const onImageLoad = (e) => {
    imgRef.current = e.currentTarget;
  };

  // Draw the cropped image to canvas when Crop button is clicked
  const handleCrop = () => {
    if (!completedCrop || !previewCanvasRef.current || !imgRef.current) return;
    const image = imgRef.current;
    const canvas = previewCanvasRef.current;
    const crop = completedCrop;
    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;
    const ctx = canvas.getContext('2d');
    canvas.width = crop.width;
    canvas.height = crop.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      image,
      crop.x * scaleX,
      crop.y * scaleY,
      crop.width * scaleX,
      crop.height * scaleY,
      0,
      0,
      crop.width,
      crop.height
    );
    // Convert canvas to data URL and show preview
    const url = canvas.toDataURL('image/png');
    setCroppedUrl(url);
    if (onCrop) onCrop(url);
  };

  return (
    <div className="p-4">
      <input type="file" accept="image/*" onChange={onSelectFile} />
      {src && (
        <ReactCrop
          crop={crop}
          onChange={(c) => setCrop(c)}
          onComplete={(c) => setCompletedCrop(c)}
          aspect={undefined}
          minWidth={10}
          minHeight={10}
        >
          <img
            ref={imgRef}
            alt="Source"
            src={src}
            onLoad={onImageLoad}
            style={{ maxWidth: '100%' }}
          />
        </ReactCrop>
      )}
      {src && (
        <div className="mt-4">
          <button
            className="px-4 py-2 bg-blue-600 text-white rounded"
            onClick={handleCrop}
            disabled={!completedCrop || !completedCrop.width || !completedCrop.height}
          >
            Crop
          </button>
        </div>
      )}
      {/* Only show preview after Crop button is clicked */}
      {croppedUrl && (
        <div className="mt-4">
          <div>Cropped Preview:</div>
          <img src={croppedUrl} alt="Cropped preview" className="mt-2 border max-w-full max-h-96" />
        </div>
      )}
      {/* Hidden canvas for cropping logic */}
      <canvas ref={previewCanvasRef} style={{ display: 'none' }} />
    </div>
  );
}

export default ImageCropper; 