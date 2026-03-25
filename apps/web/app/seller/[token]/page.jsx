'use client';

import { useEffect, useMemo, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';
const cursorKey = (token) => `carsoo_seller_cursor_${token}`;

export default function SellerCapturePage({ params }) {
  const { token } = params;
  const [groups, setGroups] = useState([]);
  const [assets, setAssets] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [sessionStatus, setSessionStatus] = useState('draft');
  const [missingRequired, setMissingRequired] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState('');
  const [agreeDocs, setAgreeDocs] = useState(false);

  const allSteps = useMemo(() => groups.flatMap((group) => group.steps), [groups]);

  useEffect(() => {
    const load = async () => {
      const [stepsResp, sessionResp] = await Promise.all([
        fetch(`${API_BASE}/api/steps`),
        fetch(`${API_BASE}/api/sessions/${token}`)
      ]);
      const stepsData = await stepsResp.json();
      const sessionData = await sessionResp.json();
      const flatSteps = stepsData.flatMap((group) => group.steps);
      setGroups(stepsData);
      setAssets(sessionData.assets || []);
      setReviews(sessionData.reviews || []);
      setSessionStatus(sessionData.session.status);
      setMissingRequired(sessionData.missing_required || 0);

      const serverIndex = flatSteps.findIndex((step) => step.stepKey === sessionData.next_step_key);
      const localCursor = window.localStorage.getItem(cursorKey(token));
      const localIndex = flatSteps.findIndex((step) => step.stepKey === localCursor);
      setActiveIndex(serverIndex >= 0 ? serverIndex : Math.max(localIndex, 0));
      setLoading(false);
    };
    load();
  }, [token]);

  useEffect(() => {
    const step = allSteps[activeIndex];
    if (step) {
      window.localStorage.setItem(cursorKey(token), step.stepKey);
    }
  }, [token, allSteps, activeIndex]);

  const assetMap = useMemo(() => {
    const map = {};
    assets.forEach((asset) => {
      if (!map[asset.step_key]) {
        map[asset.step_key] = [];
      }
      map[asset.step_key].push(asset);
    });
    return map;
  }, [assets]);

  const reviewMap = useMemo(() => {
    const map = {};
    reviews.forEach((review) => {
      map[review.step_key] = review;
    });
    return map;
  }, [reviews]);

  const requiredSteps = useMemo(() => allSteps.filter((step) => step.required), [allSteps]);

  const completedRequired = useMemo(() => {
    return requiredSteps.filter((step) => (assetMap[step.stepKey] || []).length >= step.minCount).length;
  }, [requiredSteps, assetMap]);

  const totalRequired = requiredSteps.length;
  const progress = totalRequired ? Math.round((completedRequired / totalRequired) * 100) : 0;
  const activeStep = allSteps[activeIndex] || null;

  const chooseAutoAdvanceIndex = (currentStep, nextAssetMap) => {
    const requiredIncomplete = allSteps.filter(
      (step) => step.required && (nextAssetMap[step.stepKey] || []).length < step.minCount
    );
    if (requiredIncomplete.length > 0) {
      const nextRequired = requiredIncomplete[0];
      return allSteps.findIndex((step) => step.stepKey === nextRequired.stepKey);
    }

    const optionalIncomplete = allSteps.filter(
      (step) => !step.required && (nextAssetMap[step.stepKey] || []).length < step.minCount
    );
    if (optionalIncomplete.length > 0) {
      const nextOptional = optionalIncomplete[0];
      return allSteps.findIndex((step) => step.stepKey === nextOptional.stepKey);
    }

    return allSteps.findIndex((step) => step.stepKey === currentStep.stepKey);
  };

  const handleUpload = async (event, step) => {
    if (!event.target.files || event.target.files.length === 0) return;
    setUploading(true);
    setNotice('');
    try {
      const file = event.target.files[0];
      const formData = new FormData();
      formData.append('step_key', step.stepKey);
      formData.append('file', file);
      const uploadResp = await fetch(`${API_BASE}/api/sessions/${token}/upload?step_key=${encodeURIComponent(step.stepKey)}`, {
        method: 'POST',
        body: formData
      });
      if (!uploadResp.ok) {
        const error = await uploadResp.json();
        throw new Error(error.detail || 'Upload failed');
      }
      const uploadData = await uploadResp.json();
      const uploadedAsset = { id: uploadData.id, step_key: step.stepKey, file_url: uploadData.fileUrl };
      setAssets((prev) => {
        const nextAssets = [...prev, uploadedAsset];
        const nextAssetMap = {};
        nextAssets.forEach((asset) => {
          if (!nextAssetMap[asset.step_key]) nextAssetMap[asset.step_key] = [];
          nextAssetMap[asset.step_key].push(asset);
        });
        if (step.required) {
          const nextIndex = chooseAutoAdvanceIndex(step, nextAssetMap);
          if (nextIndex >= 0) setActiveIndex(nextIndex);
        }
        return nextAssets;
      });

      const sessionResp = await fetch(`${API_BASE}/api/sessions/${token}`);
      if (sessionResp.ok) {
        const sessionData = await sessionResp.json();
        setMissingRequired(sessionData.missing_required || 0);
      }
    } catch (error) {
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
    if (!resp.ok) {
      const error = await resp.json();
      setNotice(error.detail || 'Submit failed');
      return;
    }
    setSessionStatus('submitted');
  };

  if (loading) {
    return <main>Loading...</main>;
  }

  return (
    <main>
      <div className="card">
        <h1>Seller Capture Session</h1>
        <p>Status: <span className="tag">{sessionStatus}</span></p>
        <div className="progress" style={{ marginBottom: '0.5rem' }}>
          <div style={{ width: `${progress}%` }} />
        </div>
        <p>{progress}% required steps completed ({completedRequired}/{totalRequired}).</p>
        {notice && <div className="alert">{notice}</div>}
        {missingRequired > 0 && <p className="alert">Missing {missingRequired} required steps before submission.</p>}
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        {activeStep ? (
          <div>
            <p style={{ marginBottom: '0.5rem' }}>Step {activeIndex + 1} of {allSteps.length}</p>
            <h2>{activeStep.title}</h2>
            <p>{activeStep.description}</p>
            {reviewMap[activeStep.stepKey]?.decision === 'retake' && (
              <div className="alert">
                Retake requested: {reviewMap[activeStep.stepKey]?.comment || 'Please reshoot this step.'}
              </div>
            )}
            <p>Required: {activeStep.required ? 'Yes' : 'Optional'} • Min {activeStep.minCount}</p>

            <input
              type="file"
              id="camera-input"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              disabled={uploading}
              onChange={(event) => handleUpload(event, activeStep)}
            />
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                className="button secondary"
                type="button"
                onClick={() => setActiveIndex((prev) => Math.max(prev - 1, 0))}
                disabled={activeIndex === 0 || uploading}
              >
                Back
              </button>
              <label htmlFor="camera-input" className="button" style={{ margin: 0 }}>
                {(assetMap[activeStep.stepKey] || []).length > 0 ? 'Retake' : 'Take photo'}
              </label>
              <button
                className="button secondary"
                type="button"
                onClick={() => setActiveIndex((prev) => Math.min(prev + 1, allSteps.length - 1))}
                disabled={activeIndex >= allSteps.length - 1 || uploading}
              >
                Next
              </button>
            </div>

            <div className="thumb-list" style={{ marginTop: '1rem' }}>
              {(assetMap[activeStep.stepKey] || []).map((asset) => (
                <img key={asset.id} src={asset.file_url} className="thumb" alt={activeStep.title} />
              ))}
            </div>
          </div>
        ) : (
          <p>No steps configured.</p>
        )}
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
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
