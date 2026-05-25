import { useState, useCallback, useRef } from 'react';

interface ModelUploaderProps {
  onUpload: (file: File) => void;
  isUploading?: boolean;
}

export function ModelUploader({ onUpload, isUploading }: ModelUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.stl') || file.name.endsWith('.step') || file.name.endsWith('.stp') || file.name.endsWith('.3mf'))) {
      onUpload(file);
    }
  }, [onUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleClick = () => fileInputRef.current?.click();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onUpload(file);
  };

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={handleClick}
      className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition ${
        isDragging
          ? 'border-blue-500 bg-blue-500/10'
          : 'border-gray-600 hover:border-gray-500 bg-gray-800/30'
      } ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".stl,.step,.stp,.3mf"
        onChange={handleFileSelect}
        className="hidden"
      />
      <p className="text-gray-400 text-xs">
        {isUploading ? 'Uploading...' : 'Drop STL/3MF or click to browse'}
      </p>
    </div>
  );
}
