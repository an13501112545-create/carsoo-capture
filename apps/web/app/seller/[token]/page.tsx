'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { resolvePreviewUrl } from '../../../lib/preview-url';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';

interface Step {
  stepKey: string;
  title: string;
  description: string;
  required: boolean;
  minCount: number;
  mode: string;
}

interface Asset {
  id: number;
  step_key: string;
  preview_url: string;
}

interface Review {
  step_key: string;
  decision: string;
  comment?: string;
}

export default function SellerCapturePage({ params }: { params: { token: string } }) {
  const { token } = params;
  const [steps, setSteps] = useState<Step[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [sessionStatus, setSessionStatus] = useState<string>('draft');
  const [missingRequired, setMissingRequired] = useState<number>(0);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [uploading, setUploading] = useState<boolean>(false);
  const [notice, setNotice] = useState<string>('');
  const [agreeDocs, setAgreeDocs] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const load = async () => {
      const [stepsResp, sessionResp] = await Promise.all([
        fetch(`${API_BASE}/api/steps`),
        fetch(`${API_BASE}/api/sessions/${token}`)
      ]);
      const stepsData = await stepsResp.json();
      const sessionData = await sessionResp.json();
      setSteps(stepsData || []);
      setAssets(sessionData.assets || []);
      setReviews(sessionData.reviews || []);
      setSessionStatus(sessionData.session.status);
      setMissingRequired(sessionData.missing_required || 0);
      const nextStepKey = sessionData.next_step_key;
      const nextIndex = (stepsData || []).findIndex((step: Step) => step.stepKey === nextStepKey);
      setActiveIndex(nextIndex >= 0 ? nextIndex : 0);
      setLoading(false);
    };
    load();
  }, [token]);

  const activeStep = steps[activeIndex] || null;

  const assetMap = useMemo(() => {
    const map: Record<string, Asset[]> = {};
    assets.forEach((asset) => {
      if (!map[asset.step_key]) map[asset.step_key] = [];
      map[asset.step_key].push(asset);
    });
    return map;
  }, [assets]);

  const reviewMap = useMemo(() => {
    const map: Record<string, Review> = {};
    reviews.forEach((review) => {
      map[review.step_key] = review;
    });
    return map;
  }, [reviews]);

  const requiredSteps = useMemo(() => steps.filter((step) => step.required), [steps]);
  const completedRequired = useMemo(
    () => requiredSteps.filter((step) => (assetMap[step.stepKey] || []).length >= step.minCount).length,
    [requiredSteps, assetMap]
  );

  const openFilePicker = () => {
    inputRef.current?.click();
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files || event.target.files.length === 0 || !activeStep) return;
    setUploading(true);
    setNotice('');
    try {
      const file = event.target.files[0];
      if (!file.type.startsWith('image/')) {
        throw new Error('Only image uploads are allowed.');
      }
      const formData = new FormData();
      formData.append('step_key', activeStep.stepKey);
      formData.append('file', file);

      const uploadResp = await fetch(`${API_BASE}/api/sessions/${token}/assets`, {
        method: 'POST',
        body: formData
      });
      const uploadData = await uploadResp.json();
      if (!uploadResp.ok) {
        throw new Error(uploadData.detail || 'Upload failed');
      }

      setAssets((prev) => [...prev, uploadData]);
    } catch (error: any) {
      setNotice(error.message);
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const handleSubmit = async () => {
    setNotice('');
    const resp = await fetch(`${API_BASE}/api/sessions/${token}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agree_documents_redaction: agreeDocs })
    });
    const data = await resp.json();
    if (!resp.ok) {
      setNotice(data.detail || 'Submit failed');
      return;
    }
    setSessionStatus('submitted');
  };

  if (loading) return <main>Loading...</main>;
  if (!activeStep) return <main>No steps configured.</main>;

  const activeAssets = assetMap[activeStep.stepKey] || [];
  const retakeRequested = reviewMap[activeStep.stepKey]?.decision === 'retake';

  return (
    <main>
      <div className="card">
        <h1>Seller Capture Session</h1>
        <p>Status: <span className="tag">{sessionStatus}</span></p>
        <p>Required progress: {completedRequired}/{requiredSteps.length}</p>
        {missingRequired > 0 && <p className="alert">Missing {missingRequired} required steps before submission.</p>}
        {notice && <div className="alert">{notice}</div>}
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <p>Step {activeIndex + 1} of {steps.length}</p>
        <h2>{activeStep.title}</h2>
        <p>{activeStep.description}</p>
        <p>Required: {activeStep.required ? 'Yes' : 'Optional'}</p>
        {retakeRequested && <div className="alert">Retake requested: {reviewMap[activeStep.stepKey]?.comment || 'Please retake this photo.'}</div>}

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleUpload}
          disabled={uploading}
          style={{ display: 'none' }}
        />

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button className="button" type="button" onClick={openFilePicker} disabled={uploading}>
            {activeAssets.length > 0 ? 'Retake' : 'Take photo'}
          </button>
          {!activeStep.required && (
            <button className="button secondary" type="button" onClick={() => setActiveIndex((i) => Math.min(i + 1, steps.length - 1))}>
              Skip for now
            </button>
          )}
        </div>

        <div className="thumb-list" style={{ marginTop: '1rem' }}>
          {activeAssets.map((asset) => (
            <img key={asset.id} src={resolvePreviewUrl(asset.preview_url)} className="thumb" alt={activeStep.title} />
          ))}
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button className="button secondary" type="button" onClick={() => setActiveIndex((i) => Math.max(i - 1, 0))} disabled={activeIndex === 0}>
            Back
          </button>
          <button className="button secondary" type="button" onClick={() => setActiveIndex((i) => Math.min(i + 1, steps.length - 1))} disabled={activeIndex === steps.length - 1}>
            Next
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2>Submit session</h2>
        <label>
          <input
            type="checkbox"
            checked={agreeDocs}
            onChange={(event) => setAgreeDocs(event.target.checked)}
            style={{ width: 'auto', marginRight: '0.5rem' }}
          />
          I confirm documents are redacted (address/ID numbers) before upload.
        </label>
        <div style={{ marginTop: '1rem' }}>
          <button className="button" type="button" onClick={handleSubmit}>
            Submit for review
          </button>
        </div>
      </div>
    </main>
  );
}
