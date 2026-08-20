import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, ImagePlus, Pencil, Upload } from 'lucide-react';

type GarmentImageSource = 'catalogue' | 'plm';

type Props = {
  source: GarmentImageSource;
  styleKey: string | number | null | undefined;
  image?: string | null;
  alt: string;
  className?: string;
  children?: ReactNode;
  onSaved?: (imageUrl: string) => void;
};

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;

function putWithProgress(url: string, file: File, onProgress: (progress: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('Content-Type', file.type);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.max(1, Math.round((event.loaded / event.total) * 100)));
    };
    request.onerror = () => reject(new Error('The image upload was interrupted'));
    request.onload = () => request.status >= 200 && request.status < 300
      ? resolve()
      : reject(new Error(`The image upload failed (${request.status})`));
    request.send(file);
  });
}

export default function GarmentImage({ source, styleKey, image, alt, className = '', children, onSaved }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [persistedImage, setPersistedImage] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const key = String(styleKey ?? '').trim();
  const canonicalImageUrl = key ? `/api/workspace/garment-images/${source}/${encodeURIComponent(key)}` : null;
  const currentImage = preview || persistedImage || image || null;
  const uploading = progress !== null;

  useEffect(() => {
    let cancelled = false;
    setPersistedImage(null);
    if (!canonicalImageUrl) return undefined;
    void fetch(canonicalImageUrl, { method: 'HEAD', credentials: 'include' })
      .then((response) => { if (!cancelled && response.ok) setPersistedImage(canonicalImageUrl); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [canonicalImageUrl]);

  const chooseFile = async (file?: File) => {
    if (!file || uploading || !key) return;
    setError('');
    setNotice('');
    if (!ACCEPTED_TYPES.includes(file.type) || file.size < 1 || file.size > MAX_BYTES) {
      setError('Use a JPEG, PNG, or WebP image up to 8 MB.');
      return;
    }
    const optimisticUrl = URL.createObjectURL(file);
    setPreview(optimisticUrl);
    setProgress(1);
    try {
      const upload = await fetch('/api/workspace/garment-images/upload-url', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, styleKey: key, name: file.name, size: file.size, contentType: file.type }),
      });
      const uploadBody = await upload.json().catch(() => ({}));
      if (!upload.ok) throw new Error(String(uploadBody.error || 'Could not prepare the image upload'));
      await putWithProgress(String(uploadBody.uploadUrl), file, setProgress);
      setProgress(98);
      const finalize = await fetch('/api/workspace/garment-images/finalize', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source, styleKey: key, objectPath: uploadBody.objectPath,
          name: file.name, size: file.size, contentType: file.type,
        }),
      });
      const finalBody = await finalize.json().catch(() => ({}));
      if (!finalize.ok) throw new Error(String(finalBody.error || 'Could not save this image'));
      const imageUrl = `${String(finalBody.imageUrl)}?v=${Date.now()}`;
      URL.revokeObjectURL(optimisticUrl);
      setPreview(imageUrl);
      setNotice('Image updated');
      onSaved?.(imageUrl);
      window.setTimeout(() => setNotice(''), 2400);
    } catch (uploadError) {
      URL.revokeObjectURL(optimisticUrl);
      setPreview(null);
      setError(uploadError instanceof Error ? uploadError.message : 'Could not update the image');
    } finally {
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className={`garment-image ${className} ${currentImage ? 'has-image' : 'is-empty'}`}>
      {currentImage ? <img src={currentImage} alt={alt} loading="lazy" /> : <ImagePlus aria-hidden="true" size={22} />}
      {key ? (
        <label className="garment-image-action" onClick={(event) => { event.preventDefault(); event.stopPropagation(); inputRef.current?.click(); }}>
          {currentImage ? <><Pencil size={12} /> Update image</> : <><Upload size={13} /> Add image</>}
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => void chooseFile(event.target.files?.[0])}
            disabled={uploading}
            aria-label={`${currentImage ? 'Update' : 'Add'} image for ${alt}`}
          />
        </label>
      ) : null}
      {children}
      {uploading ? <span className="garment-image-progress" aria-live="polite">{progress < 98 ? `Uploading ${progress}%` : 'Saving image…'}</span> : null}
      {notice ? <span className="garment-image-notice" role="status"><Check size={12} /> {notice}</span> : null}
      {error ? <span className="garment-image-error" role="alert">{error}</span> : null}
    </div>
  );
}