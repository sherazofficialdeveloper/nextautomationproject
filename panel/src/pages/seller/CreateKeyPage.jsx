import React, { useState } from 'react';
import { KeyIcon, CopyIcon, CheckIcon } from '../../components/Icons';
import { createSellerKey } from '../../services/panelService';

export function CreateKeyPage({ onNavigate }) {
  const [durationValue, setDurationValue] = useState('1');
  const [durationUnit, setDurationUnit] = useState('months');
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [generatedKey, setGeneratedKey] = useState(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setCopied(false);

    try {
      const res = await createSellerKey({
        durationValue: parseInt(durationValue, 10),
        durationUnit,
        startDate,
      });
      setGeneratedKey(res);
    } catch (err) {
      setError(err.message || 'Failed to generate key');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (generatedKey?.key) {
      navigator.clipboard.writeText(generatedKey.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <div style={{ maxWidth: '680px', margin: '0 auto' }}>
      <div className="panel-card-box">
        <div className="card-box-header">
          <div className="header-left-title">
            <h3>Generate License Key</h3>
            <p>Issue a new NETX Pro access key for customer activation</p>
          </div>
        </div>

        {error && <div className="alert-box error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>License Duration *</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
              {[
                { val: '1', label: '1 Month' },
                { val: '3', label: '3 Months' },
                { val: '6', label: '6 Months' },
                { val: '12', label: '12 Months' },
              ].map((opt) => (
                <button
                  key={opt.val}
                  type="button"
                  onClick={() => setDurationValue(opt.val)}
                  style={{
                    padding: '12px 8px',
                    borderRadius: '10px',
                    border: durationValue === opt.val ? '1px solid #3b82f6' : '1px solid #e2e8f0',
                    background: durationValue === opt.val ? 'rgba(37, 99, 235, 0.1)' : '#f8fafc',
                    color: durationValue === opt.val ? '#0066ff' : '#64748b',
                    fontFamily: 'inherit',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label>Activation / Start Date *</label>
            <input
              type="date"
              className="form-input"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
            />
          </div>

          <div style={{ marginTop: '24px' }}>
            <button
              type="submit"
              className="btn-primary"
              disabled={loading}
              style={{ width: '100%', justifyContent: 'center', padding: '12px' }}
            >
              <KeyIcon size={18} />
              <span>{loading ? 'Generating Key...' : 'Generate License Key'}</span>
            </button>
          </div>
        </form>

        {/* Generated Key Presentation Card */}
        {generatedKey && (
          <div
            style={{
              marginTop: '28px',
              padding: '24px',
              background: '#f0fdf4',
              border: '1px solid #bbf7d0',
              borderRadius: '14px',
              boxShadow: '0 4px 12px rgba(16, 185, 129, 0.1)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: '#059669', textTransform: 'uppercase' }}>
                Key Generated Successfully
              </span>
              <span className="status-pill active">{generatedKey.status || 'ACTIVE'}</span>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: '#ffffff',
                border: '1px solid #cbd5e1',
                borderRadius: '10px',
                padding: '12px 16px',
                marginBottom: '16px',
              }}
            >
              <span
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '14px',
                  fontWeight: 600,
                  color: '#0066ff',
                  letterSpacing: '0.5px',
                  wordBreak: 'break-all',
                }}
              >
                {generatedKey.key}
              </span>
              <button
                type="button"
                className="btn-primary"
                onClick={handleCopy}
                style={{ padding: '8px 14px', fontSize: '12.5px', marginLeft: '12px', flexShrink: 0 }}
              >
                {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                <span>{copied ? 'Copied!' : 'Copy'}</span>
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', fontSize: '12px', color: '#64748b' }}>
              <div>
                <span style={{ display: 'block', color: '#64748b' }}>Duration</span>
                <strong style={{ color: '#0f172a' }}>{generatedKey.duration || `${generatedKey.durationValue} months`}</strong>
              </div>
              <div>
                <span style={{ display: 'block', color: '#64748b' }}>Starts On</span>
                <strong style={{ color: '#0f172a' }}>{generatedKey.startDate || startDate}</strong>
              </div>
              <div>
                <span style={{ display: 'block', color: '#64748b' }}>Expires On</span>
                <strong style={{ color: '#059669' }}>{generatedKey.expiresAt}</strong>
              </div>
            </div>

            <div style={{ marginTop: '16px', textAlign: 'right' }}>
              <button
                type="button"
                className="btn-secondary"
                style={{ fontSize: '12px', padding: '6px 14px' }}
                onClick={() => onNavigate('my-keys')}
              >
                View in My Keys →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
