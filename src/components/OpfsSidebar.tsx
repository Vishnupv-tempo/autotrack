import React, { useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Film,
  FolderOpen,
  HardDrive,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import type { CvTrackerSettings, OpfsVideoEntry, StorageUsageInfo } from '../types/tracking';
import { formatBytes } from '../utils/opfs';

interface OpfsSidebarProps {
  videos: OpfsVideoEntry[];
  activeVideoName: string | null;
  storageInfo: StorageUsageInfo;
  isUploading: boolean;
  uploadProgress: number;
  isGeneratingSample: boolean;
  sampleProgress: number;
  cvSettings: CvTrackerSettings;
  isCollapsed: boolean;
  showVisionSettings: boolean;
  onToggleCollapse: () => void;
  onOpenVisionSettings: () => void;
  onToggleVisionSettings: () => void;
  onUpdateSettings: (next: CvTrackerSettings) => void;
  onSelectVideo: (name: string) => void;
  onUploadFiles: (files: FileList) => void;
  onDeleteVideo: (name: string) => void;
  onGenerateSample: () => void;
}

export const OpfsSidebar: React.FC<OpfsSidebarProps> = ({
  videos,
  activeVideoName,
  storageInfo,
  isUploading,
  uploadProgress,
  isGeneratingSample,
  sampleProgress,
  cvSettings,
  isCollapsed,
  showVisionSettings,
  onToggleCollapse,
  onOpenVisionSettings,
  onToggleVisionSettings,
  onUpdateSettings,
  onSelectVideo,
  onUploadFiles,
  onDeleteVideo,
  onGenerateSample,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onUploadFiles(e.dataTransfer.files);
    }
  };

  const quotaPct =
    storageInfo.quotaBytes > 0
      ? Math.min(100, Math.max(1, (storageInfo.usageBytes / storageInfo.quotaBytes) * 100))
      : 0;

  if (isCollapsed) {
    return (
      <aside
        id="opfs-library"
        aria-label="Minimized OPFS Library"
        className="w-full lg:w-8 lg:h-full shrink-0 bg-[#10151D] border-b lg:border-b-0 lg:border-r border-[#1E2936] flex lg:flex-col items-center justify-between px-1.5 py-1 lg:px-0 lg:py-2 gap-1.5"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="video/mp4,video/webm,video/quicktime,video/*"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              onUploadFiles(e.target.files);
              e.target.value = '';
            }
          }}
        />

        <div className="flex lg:flex-col items-center gap-1">
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label="Expand OPFS Video Library"
            title="Expand OPFS Library & Vision Settings"
            className="w-6 h-6 rounded flex items-center justify-center bg-[#151C26] hover:bg-[#1E2936] border border-[#243040] text-slate-300 hover:text-emerald-400 transition-colors focus-visible:outline-2 focus-visible:outline-emerald-400"
          >
            <PanelLeftOpen className="w-3 h-3" />
          </button>

          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={`OPFS Video Library (${videos.length} clips)`}
            title={`OPFS Video Library (${videos.length} ${videos.length === 1 ? 'clip' : 'clips'})`}
            className="relative w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-100 hover:bg-[#192330] transition-colors"
          >
            <Film className="w-3 h-3" />
            {videos.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[11px] h-[11px] px-0.5 rounded-full bg-emerald-500/90 text-slate-950 text-[8px] font-mono font-bold leading-[11px] text-center">
                {videos.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            aria-label="Import match video"
            title="Import Match Video into OPFS"
            className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-emerald-400 hover:bg-[#192330] transition-colors disabled:opacity-50"
          >
            <Upload className="w-3 h-3" />
          </button>

          <button
            type="button"
            onClick={onOpenVisionSettings}
            aria-label="Open Vision Tracker Parameters"
            title="Vision Tracker Parameters"
            className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-emerald-400 hover:bg-[#192330] transition-colors"
          >
            <SlidersHorizontal className="w-3 h-3" />
          </button>
        </div>

        <button
          type="button"
          onClick={onToggleCollapse}
          title={`${storageInfo.backend === 'opfs' ? 'Origin Private FS' : 'Session Storage'}: ${formatBytes(storageInfo.usageBytes)}`}
          aria-label="View storage usage"
          className="w-6 h-6 rounded flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-[#192330] transition-colors"
        >
          <HardDrive className="w-3 h-3" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      id="opfs-library"
      className="w-full lg:w-[210px] lg:h-full lg:min-h-0 shrink-0 bg-[#10151D] border-b lg:border-b-0 lg:border-r border-[#1E2936] flex flex-col"
    >
      {/* Compact OPFS Library Header + Import / Sample Actions */}
      <div className="p-2.5 border-b border-[#1E2936] shrink-0">
        <div className="flex items-center justify-between gap-1.5 mb-1.5">
          <h2 className="text-[11px] font-semibold text-slate-100 tracking-tight truncate">
            OPFS Video Library
          </h2>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[10px] text-slate-400 font-mono tabular-nums">
              {videos.length} {videos.length === 1 ? 'clip' : 'clips'}
            </span>
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label="Minimize left panel"
              title="Minimize left panel"
              className="p-0.5 rounded text-slate-400 hover:text-slate-100 hover:bg-[#192330] transition-colors"
            >
              <PanelLeftClose className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Upload Dropzone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`rounded border border-dashed p-1.5 transition-colors ${
            isDragging
              ? 'border-emerald-400 bg-emerald-500/10'
              : 'border-[#2B394B] bg-[#151C26] hover:border-[#3A4D63]'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime,video/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                onUploadFiles(e.target.files);
                e.target.value = '';
              }
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="w-full flex items-center justify-center gap-1.5 py-1 px-2 rounded bg-[#1D2735] hover:bg-[#253244] text-slate-100 text-[10px] font-medium transition-colors whitespace-nowrap disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-emerald-400"
          >
            <Upload className="w-3 h-3 text-emerald-400 shrink-0" />
            <span>{isUploading ? `Writing OPFS ${uploadProgress}%` : 'Import Match Video'}</span>
          </button>
          <p className="mt-1 text-[9.5px] text-slate-400 text-center leading-snug">
            Drop MP4, WebM, or MOV into browser OPFS
          </p>
        </div>

        {/* Built-in Sample Generator */}
        <button
          type="button"
          onClick={onGenerateSample}
          disabled={isGeneratingSample}
          className="mt-1.5 w-full flex items-center justify-center gap-1.5 py-1 px-2 rounded border border-[#243040] bg-[#121821] hover:bg-[#19222E] text-slate-200 text-[10px] font-medium transition-colors whitespace-nowrap disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-emerald-400"
        >
          {isGeneratingSample ? (
            <>
              <Sparkles className="w-3 h-3 text-amber-400 animate-spin shrink-0" />
              <span className="font-mono tabular-nums">Rendering {sampleProgress}%</span>
            </>
          ) : (
            <>
              <Plus className="w-3 h-3 text-emerald-400 shrink-0" />
              <span>Generate Sample Match</span>
            </>
          )}
        </button>
      </div>

      {/* Stored Clips List */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1 min-h-[80px]">
        {videos.length === 0 ? (
          <div className="py-5 px-2.5 text-center">
            <FolderOpen className="w-5 h-5 text-slate-600 mx-auto mb-1.5" />
            <p className="text-[11px] font-medium text-slate-300">No clips in OPFS yet</p>
            <p className="mt-1 text-[10px] text-slate-400 leading-relaxed">
              Import a match video or generate a tactical sample above.
            </p>
          </div>
        ) : (
          videos.map((video) => {
            const isActive = video.name === activeVideoName;
            const ext = video.name.split('.').pop()?.toUpperCase() || 'VIDEO';
            return (
              <div
                key={video.name}
                className={`group flex items-center justify-between gap-1 px-2 py-1.5 rounded border transition-colors ${
                  isActive
                    ? 'bg-[#192330] border-emerald-500/40 text-slate-100'
                    : 'bg-transparent border-transparent hover:bg-[#151C26] hover:border-[#243040] text-slate-300'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectVideo(video.name)}
                  className="flex-1 min-w-0 text-left flex items-start gap-1.5 focus-visible:outline-2 focus-visible:outline-emerald-400 rounded"
                >
                  <Film
                    className={`w-3 h-3 mt-0.5 shrink-0 ${
                      isActive ? 'text-emerald-400' : 'text-slate-500'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-medium truncate" title={video.name}>
                      {video.name}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[9.5px] text-slate-400 font-mono tabular-nums">
                      <span>{ext}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatBytes(video.size)}</span>
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => onDeleteVideo(video.name)}
                  aria-label={`Delete ${video.name} from OPFS`}
                  title="Remove from OPFS"
                  className="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 opacity-75 group-hover:opacity-100 transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-rose-400"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Vision Tracker Parameters (Moved to Left Panel) */}
      <div id="cv-settings" className="border-t border-[#1E2936] bg-[#0D1218] shrink-0">
        <button
          type="button"
          onClick={onToggleVisionSettings}
          aria-expanded={showVisionSettings}
          className="w-full px-2.5 py-2 flex items-center justify-between text-[11px] font-semibold text-slate-200 hover:bg-[#121821] transition-colors"
        >
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <SlidersHorizontal className="w-3 h-3 text-emerald-400 shrink-0" />
            <span>Vision Tracker Parameters</span>
          </span>
          {showVisionSettings ? (
            <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />
          )}
        </button>

        {showVisionSettings && (
          <div className="px-2.5 pb-2.5 pt-0.5 space-y-2 text-[11px] max-h-[210px] overflow-y-auto">
            <div>
              <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                <span>Search Window</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {cvSettings.searchRadiusPx}px
                </span>
              </div>
              <input
                type="range"
                min={20}
                max={84}
                step={2}
                value={cvSettings.searchRadiusPx}
                onChange={(e) =>
                  onUpdateSettings({
                    ...cvSettings,
                    searchRadiusPx: Number(e.target.value),
                  })
                }
                className="pitch-slider w-full"
              />
            </div>

            <div>
              <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                <span>Template Adaptation</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {Math.round(cvSettings.adaptationRate * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={30}
                step={2}
                value={Math.round(cvSettings.adaptationRate * 100)}
                onChange={(e) =>
                  onUpdateSettings({
                    ...cvSettings,
                    adaptationRate: Number(e.target.value) / 100,
                  })
                }
                className="pitch-slider w-full"
              />
            </div>

            <div>
              <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                <span>Motion Smoothing</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {Math.round((cvSettings.smoothing ?? 0.65) * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={95}
                step={5}
                value={Math.round((cvSettings.smoothing ?? 0.65) * 100)}
                onChange={(e) =>
                  onUpdateSettings({
                    ...cvSettings,
                    smoothing: Number(e.target.value) / 100,
                  })
                }
                className="pitch-slider w-full"
              />
            </div>

            <div className="pt-0.5 space-y-1">
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-[10px] text-slate-300">Pitch Turf Suppression</span>
                <input
                  type="checkbox"
                  checked={cvSettings.turfMasking}
                  onChange={(e) =>
                    onUpdateSettings({
                      ...cvSettings,
                      turfMasking: e.target.checked,
                    })
                  }
                  className="accent-emerald-500 w-3 h-3 rounded"
                />
              </label>

              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-[10px] text-slate-300">Camera Pan Compensation</span>
                <input
                  type="checkbox"
                  checked={cvSettings.cameraCompensation}
                  onChange={(e) =>
                    onUpdateSettings({
                      ...cvSettings,
                      cameraCompensation: e.target.checked,
                    })
                  }
                  className="accent-emerald-500 w-3 h-3 rounded"
                />
              </label>

              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-[10px] text-slate-300">Anti-Swap Separation Guard</span>
                <input
                  type="checkbox"
                  checked={cvSettings.collisionAvoidance}
                  onChange={(e) =>
                    onUpdateSettings({
                      ...cvSettings,
                      collisionAvoidance: e.target.checked,
                    })
                  }
                  className="accent-emerald-500 w-3 h-3 rounded"
                />
              </label>
            </div>
          </div>
        )}
      </div>

      {/* OPFS Storage Quota Footer */}
      <div className="px-2.5 py-2 border-t border-[#1E2936] bg-[#0B0F14] shrink-0">
        <div className="flex items-center justify-between text-[9.5px] text-slate-400 mb-1">
          <span className="flex items-center gap-1 font-medium text-slate-300">
            <HardDrive className="w-2.5 h-2.5 text-slate-400" />
            {storageInfo.backend === 'opfs' ? 'Origin Private FS' : 'Session Storage'}
          </span>
          <span className="font-mono tabular-nums">
            {formatBytes(storageInfo.usageBytes)}
            {storageInfo.quotaBytes > 0 ? ` / ${formatBytes(storageInfo.quotaBytes)}` : ''}
          </span>
        </div>
        <div className="h-1 w-full bg-[#1E2936] rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500/80 transition-all duration-300"
            style={{ width: `${quotaPct}%` }}
          />
        </div>
      </div>
    </aside>
  );
};
