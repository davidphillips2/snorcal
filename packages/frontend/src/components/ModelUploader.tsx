import { useState, useCallback, useRef } from 'react';

interface ModelUploaderProps {
  onUpload: (file: File) => void;
  onUploadMany?: (files: File[]) => void;
  isUploading?: boolean;
}

const ACCEPT_RE = /\.(stl|step|stp|3mf)$/i;

export function ModelUploader({ onUpload, onUploadMany, isUploading }: ModelUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f => ACCEPT_RE.test(f.name));
    if (files.length === 0) return;
    if (files.length === 1 || !onUploadMany) onUpload(files[0]);
    else onUploadMany(files);
  }, [onUpload, onUploadMany]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleClick = () => fileInputRef.current?.click();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    if (files.length === 1 || !onUploadMany) onUpload(files[0]);
    else onUploadMany(files);
    e.target.value = '';
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
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />
      <p className="text-gray-400 text-xs">
        {isUploading ? 'Uploading...' : 'Drop STL/3MF or click to browse — multiple OK'}
      </p>
    </div>
  );
}
