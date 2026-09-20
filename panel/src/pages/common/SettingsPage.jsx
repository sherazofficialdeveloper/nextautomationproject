import React, { useState } from 'react';
import { SettingsIcon, CheckIcon } from '../../components/Icons';

export function SettingsPage() {
  const [platformName, setPlatformName] = useState('NETX Pro');
  const [sessionTimeout, setSessionTimeout] = useState('60');
  const [allowKeyAutoExpire, setAllowKeyAutoExpire] = useState(true);
  const [saved, setSaved] = useState(false);

  const handleSave = (e) => {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div>
      <div className="panel-card-box" style={{ maxWidth: '640px' }}>
        <div className="card-box-header">
          <div className="header-left-title">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
              <SettingsIcon size={20} style={{ color: '#0066ff' }} />
              <h3>System Settings</h3>
            </div>
            <p>Configure panel behavior and licensing parameters</p>
          </div>
        </div>

        {saved && (
          <div className="alert-box success">
            <CheckIcon size={16} />
            <span>Settings saved successfully!</span>
          </div>
        )}

        <form onSubmit={handleSave}>
          <div className="form-group">
            <label>Platform Brand Name</label>
            <input
              type="text"
              className="form-input"
              value={platformName}
              onChange={(e) => setPlatformName(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label>Session Inactivity Timeout (Minutes)</label>
            <select
              className="form-select"
              value={sessionTimeout}
              onChange={(e) => setSessionTimeout(e.target.value)}
            >
              <option value="15">15 Minutes</option>
              <option value="30">30 Minutes</option>
              <option value="60">60 Minutes</option>
              <option value="120">2 Hours</option>
            </select>
          </div>

          <div className="form-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '10px', marginTop: '14px' }}>
            <input
              type="checkbox"
              id="autoExpire"
              checked={allowKeyAutoExpire}
              onChange={(e) => setAllowKeyAutoExpire(e.target.checked)}
              style={{ width: '18px', height: '18px', cursor: 'pointer' }}
            />
            <label htmlFor="autoExpire" style={{ cursor: 'pointer', marginBottom: 0 }}>
              Automatically deactivate expired license keys
            </label>
          </div>

          <div style={{ marginTop: '24px' }}>
            <button type="submit" className="btn-primary">
              <CheckIcon size={16} />
              <span>Save Configuration</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

