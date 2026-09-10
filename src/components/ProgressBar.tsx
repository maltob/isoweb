import React from 'react';

interface ProgressBarProps {
  ratio: number;
  status: string;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({ ratio, status }) => {
  const percent = Math.round(ratio * 100);

  return (
    <div className="fixed bottom-6 right-6 z-50 bg-slate-900 border border-slate-700 shadow-2xl rounded-xl p-4 w-80 text-xs animate-in fade-in slide-in-from-bottom-4 duration-200">
      <div className="flex items-center justify-between mb-2">
        <span className="font-semibold text-white truncate pr-2">{status}</span>
        <span className="font-mono text-sky-400 font-bold">{percent}%</span>
      </div>
      <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
        <div
          className="bg-gradient-to-r from-sky-500 to-indigo-500 h-full rounded-full transition-all duration-150"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};
