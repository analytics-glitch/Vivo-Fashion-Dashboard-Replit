import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Image as ImageIcon, Star, Trash2, Upload } from 'lucide-react';

export type StyleDevelopmentImage = {
  id: number;
  originalName: string;
  isPrimary: boolean;
  uploadedAt: string;
  uploadedBy: string;
  imageUrl: string;
};

type Props = {
  styleId: number;
  styleName: string;
  imageUrl: string | null;
  images: StyleDevelopmentImage[];
};

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;

export default function StyleDevelopmentImageGallery({ styleId, styleName, imageUrl, images }: Props) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker'] }),
    queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker', styleId] }),
  ]);

  const upload = async (files: File[]) => {
    if (busy || !files.length) return;
    setError('');
    const invalid = files.find(file => !TYPES.includes(file.type) || file.size < 1 || file.size > MAX_BYTES);
    if (invalid) {
      setError(`${invalid.name}: use a JPEG, PNG, or WebP image up to 8 MB.`);
      return;
    }
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setBusy(`Uploading ${index + 1} of ${files.length}…`);
        const prepared = await fetch(`/api/workspace/style-development-tracker/${styleId}/images/upload-url`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
        });
        const preparedBody = await prepared.json().catch(() => ({}));
        if (!prepared.ok) throw new Error(String(preparedBody.error || `Could not prepare ${file.name}`));
        const stored = await fetch(String(preparedBody.uploadUrl), {
          method: 'PUT', headers: { 'Content-Type': file.type }, body: file,
        });
        if (!stored.ok) throw new Error(`${file.name} could not be uploaded (${stored.status})`);
        setBusy(`Saving ${index + 1} of ${files.length}…`);
        const finalized = await fetch(`/api/workspace/style-development-tracker/${styleId}/images/finalize`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            objectPath: preparedBody.objectPath, name: file.name, size: file.size, contentType: file.type,
          }),
        });
        const finalizedBody = await finalized.json().catch(() => ({}));
        if (!finalized.ok) throw new Error(String(finalizedBody.error || `Could not save ${file.name}`));
      }
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The image upload failed');
    } finally {
      setBusy('');
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const update = async (image: StyleDevelopmentImage, action: 'primary' | 'delete') => {
    if (busy) return;
    if (action === 'delete' && !window.confirm(`Delete ${image.originalName}? This cannot be undone.`)) return;
    setError('');
    setBusy(action === 'delete' ? 'Deleting image…' : 'Updating primary image…');
    try {
      const response = await fetch(
        `/api/workspace/style-development-tracker/${styleId}/images/${image.id}${action === 'primary' ? '/primary' : ''}`,
        { method: action === 'primary' ? 'PATCH' : 'DELETE', credentials: 'include' },
      );
      const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(body.error || 'The image update failed'));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The image update failed');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="tracker-style-images">
      <div
        className={`tracker-drawer-image tracker-image-dropzone${dragging ? ' is-dragging' : ''}${imageUrl ? '' : ' placeholder'}`}
        role="button" tabIndex={0} aria-label={`Upload images for ${styleName}`}
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={event => {
          if ((event.key === 'Enter' || event.key === ' ') && !busy) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragEnter={event => { event.preventDefault(); setDragging(true); }}
        onDragOver={event => event.preventDefault()}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={event => {
          event.preventDefault();
          setDragging(false);
          void upload(Array.from(event.dataTransfer.files));
        }}
      >
        {imageUrl ? <img src={imageUrl} alt={`Primary image for ${styleName}`} /> : <ImageIcon size={40} />}
        <span className="tracker-image-upload-prompt"><Upload size={14} /> {busy || (images.length ? 'Add images' : 'Drop or choose images')}</span>
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={Boolean(busy)}
          onChange={event => void upload(Array.from(event.target.files ?? []))} />
      </div>
      {error && <div className="tracker-image-error" role="alert">{error}</div>}
      {images.length > 0 && <div className="tracker-image-gallery" aria-label="Style image gallery">
        {images.map(image => <article className={`tracker-image-thumb${image.isPrimary ? ' is-primary' : ''}`} key={image.id}>
          <img src={image.imageUrl} alt={image.originalName} loading="lazy" />
          <div className="tracker-image-attribution">
            <strong>{image.uploadedBy}</strong>
            <span>{new Date(image.uploadedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
          </div>
          <div className="tracker-image-actions">
            <button type="button" disabled={Boolean(busy) || image.isPrimary} onClick={() => void update(image, 'primary')}>
              {image.isPrimary ? <Check size={12} /> : <Star size={12} />} {image.isPrimary ? 'Primary' : 'Make primary'}
            </button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void update(image, 'delete')} aria-label={`Delete ${image.originalName}`}><Trash2 size={12} /></button>
          </div>
        </article>)}
      </div>}
    </div>
  );
}