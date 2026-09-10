import React, { useState } from 'react';
import { X } from 'lucide-react';

interface InputModalProps {
  title: string;
  label: string;
  initialValue?: string;
  confirmText?: string;
  onConfirm: (val: string) => void;
  onClose: () => void;
}

export const InputModal: React.FC<InputModalProps> = ({
  title,
  label,
  initialValue = '',
  confirmText = 'Confirm',
  onConfirm,
  onClose,
}) => {
  const [value, setValue] = useState(initialValue);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) {
      onConfirm(value.trim());
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          <div>
            <label className="block font-medium text-slate-300 mb-1.5">{label}</label>
            <input
              type="text"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-md text-slate-200 focus:outline-none focus:border-sky-500 font-mono"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!value.trim()}
              className="px-4 py-1.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-medium rounded transition shadow cursor-pointer"
            >
              {confirmText}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
