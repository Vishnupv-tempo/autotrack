import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BoxSelect,
  CheckCircle2,
  Crosshair,
  Disc,
  Eraser,
  Eye,
  EyeOff,
  Link2,
  Pentagon,
  Pin,
  Play,
  RotateCcw,
  ScanSearch,
  Square,
  Sun,
  Target,
} from 'lucide-react';
import type {
  ChainProperties,
  CircleStyle,
  CoverageSummary,
  ImplementedTrackRecord,
  PolygonProperties,
  RingProperties,
  SpotlightProperties,
  TrackedPlayer,
  TrackingStatus,
} from '../types/tracking';
import {
  DEFAULT_RING_THICKNESS,
  MAX_RING_SIZE,
  MAX_RING_THICKNESS,
  MIN_RING_SIZE,
  MIN_RING_THICKNESS,
  PLAYER_COLORS,
  POLYGON_COLORS,
  RING_COLORS,
  SPOTLIGHT_COLORS,
} from '../types/tracking';
import { formatTimecode } from './PlayerTransport';
import { computeContiguousIntervals } from '../utils/trackingCoverage';

interface TracksInspectorProps {
  players: TrackedPlayer[];
  implementedTracks: ImplementedTrackRecord[];
  coverageSummary: CoverageSummary;
  hoveredTrackedPlayerId: string | null;
  currentTime: number;
  duration: number;
  selectedPlayerId: string | null;
  selectedNodeId: string | null;
  realigningPlayerId: string | null;
  realigningNodeId: string | null;
  onHoverTrackedPlayer: (id: string | null) => void;
  onAttachToolToTrack: (trackId: string, style: 'ring' | 'foot-ring' | 'spotlight') => void;
  onRetrackPlayers: () => void;
  onSelectPlayer: (id: string) => void;
  onSelectNode: (nodeId: string | null) => void;
  onRenamePlayer: (id: string, label: string) => void;
  onChangePlayerColor: (id: string, color: string) => void;
  onChangePlayerStyle: (id: string, style: CircleStyle) => void;
  onUpdatePlayerSpotlight: (id: string, spotlight: SpotlightProperties) => void;
  onUpdatePlayerRing: (id: string, ring: RingProperties) => void;
  onUpdatePlayerChain: (id: string, chain: ChainProperties) => void;
  onUpdatePlayerPolygon: (id: string, polygon: PolygonProperties) => void;
  onTogglePlayerTrackWithCv: (id: string) => void;
  onTogglePlayerVisibility: (id: string) => void;
  onStopTrackingPlayer: (id: string) => void;
  onResumeTrackingPlayer: (id: string) => void;
  onDeletePlayer: (id: string) => void;
  onJumpToAnchor: (time: number) => void;
  onSeek: (time: number) => void;
  onStartRealign: (id: string, nodeId?: string | null) => void;
  onCancelRealign: () => void;
}

export const TracksInspector: React.FC<TracksInspectorProps> = ({
  players,
  implementedTracks,
  coverageSummary,
  hoveredTrackedPlayerId,
  currentTime,
  duration,
  selectedPlayerId,
  selectedNodeId,
  realigningPlayerId,
  realigningNodeId,
  onHoverTrackedPlayer,
  onAttachToolToTrack,
  onRetrackPlayers,
  onSelectPlayer,
  onSelectNode,
  onRenamePlayer,
  onChangePlayerColor,
  onChangePlayerStyle,
  onUpdatePlayerSpotlight,
  onUpdatePlayerRing,
  onUpdatePlayerChain,
  onUpdatePlayerPolygon,
  onTogglePlayerTrackWithCv,
  onTogglePlayerVisibility,
  onStopTrackingPlayer,
  onResumeTrackingPlayer,
  onDeletePlayer,
  onJumpToAnchor,
  onSeek,
  onStartRealign,
  onCancelRealign,
}) => {
  return (
    <aside
      id="player-tracks"
      className="w-full lg:w-[216px] lg:h-full lg:min-h-0 shrink-0 bg-[#10151D] border-t lg:border-t-0 lg:border-l border-[#1E2936] flex flex-col"
    >
      {implementedTracks.length > 0 && (
        <div className="border-b border-[#1E2936]">
          <div className="px-2.5 py-2 border-b border-[#1E2936]/70 flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5 min-w-0">
              <h2 className="text-[11px] font-semibold text-emerald-300 tracking-tight truncate">
                Tracked Players
              </h2>
              <span className="text-[10px] font-mono tabular-nums text-slate-400">
                {implementedTracks.length}
              </span>
            </div>
            <button
              type="button"
              onClick={onRetrackPlayers}
              title="Re-track players (replaces current implemented tracks on new Implement)"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#141D28] hover:bg-[#1C2837] border border-[#27364A] text-[10px] font-medium text-slate-200 transition-colors shrink-0"
            >
              <RotateCcw className="w-2.5 h-2.5 text-emerald-400" />
              <span>Re-track</span>
            </button>
          </div>
          <div className="px-2.5 py-1.5 border-b border-[#1E2936]/60 bg-[#0D1218] flex items-center justify-between gap-1 text-[9.5px] font-mono tabular-nums text-slate-400">
            <span className="truncate">
              <span className="text-slate-200 font-semibold">{coverageSummary.coveragePct}%</span>{' '}
              clip · Full{' '}
              <span className="text-emerald-400">{coverageSummary.fullSeconds.toFixed(1)}s</span> ·
              Boxes{' '}
              <span className="text-sky-400">{coverageSummary.partialSeconds.toFixed(1)}s</span>
            </span>
            {coverageSummary.nextGapTime !== null && (
              <button
                type="button"
                onClick={() => onSeek(coverageSummary.nextGapTime!)}
                title={`Jump to next untracked gap (${formatTimecode(coverageSummary.nextGapTime)})`}
                className="inline-flex items-center gap-0.5 text-amber-300 hover:text-amber-200 underline-offset-2 hover:underline font-sans font-medium shrink-0"
              >
                <span>Next Gap</span>
                <ArrowRight className="w-2.5 h-2.5" />
              </button>
            )}
          </div>
          <div className="max-h-48 overflow-y-auto p-1.5 space-y-1">
            {implementedTracks.map((track) => {
              const isHovered = hoveredTrackedPlayerId === track.id;
              const intervals = computeContiguousIntervals(
                track.positions.map((p) => p.time),
                0.35,
                0.08
              );
              const isInRange = intervals.some(
                (iv) => currentTime + 0.12 >= iv.start && currentTime - 0.12 <= iv.end
              );
              const isAuto = track.source === 'auto';
              const nextTrackSpan =
                intervals.find((iv) => iv.start > currentTime + 0.12) ?? intervals[0];
              return (
                <div
                  key={track.id}
                  onMouseEnter={() => onHoverTrackedPlayer(track.id)}
                  onMouseLeave={() => onHoverTrackedPlayer(null)}
                  className={`rounded border px-2 py-1.5 transition-colors ${
                    isHovered
                      ? 'bg-[#172430] border-emerald-400/60'
                      : 'bg-[#131922] border-[#1E2936] hover:border-[#2C3A4D]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[11px] font-semibold text-slate-100 truncate">
                      {track.label}
                    </span>
                    <span
                      className={`text-[9.5px] font-mono tabular-nums shrink-0 ${
                        isInRange ? 'text-emerald-300' : 'text-slate-500'
                      }`}
                    >
                      {formatTimecode(track.firstTime)}→{formatTimecode(track.lastTime)}
                    </span>
                  </div>

                  <div className="mt-0.5 flex items-center justify-between gap-1 text-[9.5px] text-slate-400">
                    <span className="inline-flex items-center gap-1 truncate">
                      {isAuto ? (
                        <ScanSearch className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
                      ) : (
                        <BoxSelect className="w-2.5 h-2.5 text-sky-400 shrink-0" />
                      )}
                      <span className={isAuto ? 'text-emerald-300' : 'text-sky-300'}>
                        {isAuto ? 'Auto' : 'Drawn Box'}
                      </span>
                      <span className="text-slate-600" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-mono tabular-nums">
                        {intervals.length} {intervals.length === 1 ? 'span' : 'spans'}
                      </span>
                    </span>
                    {!isInRange && nextTrackSpan && (
                      <button
                        type="button"
                        onClick={() => onSeek(nextTrackSpan.start)}
                        title={`Jump to ${track.label} tracked span (${formatTimecode(nextTrackSpan.start)})`}
                        className="inline-flex items-center gap-0.5 text-[9px] text-amber-300 hover:text-amber-200 underline-offset-2 hover:underline shrink-0"
                      >
                        <span>Untracked @ playhead · Jump</span>
                      </button>
                    )}
                  </div>

                  {duration > 0 && intervals.length > 0 && (
                    <div
                      role="button"
                      tabIndex={0}
                      title="Click sparkline to seek along tracked spans"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const ratio = Math.max(
                          0,
                          Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width))
                        );
                        onSeek(ratio * duration);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSeek(intervals[0]?.start ?? track.firstTime);
                        }
                      }}
                      className="mt-1 h-1.5 w-full rounded bg-[#0A0E14] border border-[#1E2936]/70 relative overflow-hidden cursor-pointer"
                    >
                      {intervals.map((iv, idx) => (
                        <div
                          key={`${track.id}_iv_${idx}`}
                          style={{
                            left: `${(iv.start / duration) * 100}%`,
                            width: `${Math.max(1.5, ((iv.end - iv.start) / duration) * 100)}%`,
                          }}
                          className={`absolute inset-y-0 ${
                            isAuto ? 'bg-emerald-400/80' : 'bg-sky-400/85'
                          }`}
                        />
                      ))}
                      <div
                        style={{
                          left: `${Math.max(0, Math.min(100, (currentTime / duration) * 100))}%`,
                        }}
                        className="absolute inset-y-0 w-[1.5px] bg-white/90 pointer-events-none"
                      />
                    </div>
                  )}

                  <div className="mt-1 grid grid-cols-3 gap-1">
                    <button
                      type="button"
                      onClick={() => onAttachToolToTrack(track.id, 'ring')}
                      title={`Attach tracked Box to ${track.label}`}
                      className="px-1 py-0.5 rounded bg-[#0E141C] hover:bg-emerald-500/15 border border-[#223042] hover:border-emerald-500/40 text-[9.5px] font-medium text-slate-200 hover:text-emerald-200 transition-colors"
                    >
                      + Box
                    </button>
                    <button
                      type="button"
                      onClick={() => onAttachToolToTrack(track.id, 'spotlight')}
                      title={`Attach tracked Spotlight to ${track.label}`}
                      className="px-1 py-0.5 rounded bg-[#0E141C] hover:bg-amber-500/15 border border-[#223042] hover:border-amber-500/40 text-[9.5px] font-medium text-slate-200 hover:text-amber-200 transition-colors"
                    >
                      + Spot
                    </button>
                    <button
                      type="button"
                      onClick={() => onAttachToolToTrack(track.id, 'foot-ring')}
                      title={`Attach tracked 3D Ring to ${track.label}`}
                      className="px-1 py-0.5 rounded bg-[#0E141C] hover:bg-cyan-500/15 border border-[#223042] hover:border-cyan-500/40 text-[9.5px] font-medium text-slate-200 hover:text-cyan-200 transition-colors"
                    >
                      + Ring
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="px-2.5 py-2 border-b border-[#1E2936] flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold text-slate-100 tracking-tight">
          Telestrations
        </h2>
        <span className="text-[10px] font-mono tabular-nums text-slate-400">
          {players.length} active
        </span>
      </div>

      {/* Player Tracks List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 min-h-[120px]">
        {players.length === 0 ? (
          <div className="py-6 px-2.5 text-center">
            <Target className="w-6 h-6 text-slate-600 mx-auto mb-2" />
            <p className="text-[11px] font-medium text-slate-300">No telestrations yet</p>
            <p className="mt-1 text-[10px] text-slate-400 leading-relaxed">
              {implementedTracks.length > 0
                ? 'Click + Box, + Spot, or + Ring on a tracked player above, or click near any tracked player on the video with a top bar tool.'
                : 'Use Player Box to track players across the clip, or draw a Box, Spotlight, 3D Ring, or Polygon directly on the video.'}
            </p>
          </div>
        ) : (
          players.map((player) => {
            const isSelected = player.id === selectedPlayerId;
            const pos = player.currentPosition;
            const confPct = Math.round(pos.confidence * 100);
            const isAtOrAfterStop =
              player.stopTime !== undefined && currentTime >= player.stopTime - 0.05;
            const isAtClipEnd =
              duration > 0 &&
              player.stopTime !== undefined &&
              player.stopTime >= duration - 0.02;

            return (
              <div
                key={player.id}
                onClick={() => onSelectPlayer(player.id)}
                className={`rounded-md border p-2 transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-[#17202C] border-[#33465E]'
                    : 'bg-[#131922] border-[#1E2936] hover:border-[#2C3A4D]'
                }`}
              >
                {/* Top row: color indicator + editable name + actions */}
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0 border border-black/40"
                      style={{ backgroundColor: player.color }}
                    />
                    <input
                      type="text"
                      value={player.label}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onRenamePlayer(player.id, e.target.value)}
                      aria-label="Player label"
                      className="w-full min-w-0 bg-transparent text-[11px] font-semibold text-slate-100 focus:bg-[#0B0F14] focus:px-1 py-0.5 rounded outline-none border border-transparent focus:border-[#33465E]"
                    />
                  </div>

                  <div className="flex items-center gap-0.5 shrink-0">
                    {!isAtOrAfterStop ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onStopTrackingPlayer(player.id);
                        }}
                        title="Stop tracking from current frame (keeps already-tracked portion)"
                        className="p-1 rounded text-slate-400 hover:text-amber-300 hover:bg-amber-500/10 transition-colors"
                      >
                        <Square className="w-3 h-3" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isAtClipEnd}
                        onClick={(e) => {
                          e.stopPropagation();
                          onResumeTrackingPlayer(player.id);
                        }}
                        title={
                          isAtClipEnd
                            ? 'Already tracks to end of video'
                            : 'Resume tracking for another 10 seconds'
                        }
                        className="p-1 rounded text-amber-300 hover:text-emerald-300 hover:bg-emerald-500/10 transition-colors disabled:opacity-35"
                      >
                        <Play className="w-3 h-3" />
                      </button>
                    )}
                    {player.trackWithCv !== false && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (realigningPlayerId === player.id) {
                            onCancelRealign();
                          } else {
                            onStartRealign(player.id);
                          }
                        }}
                        title="Realign position from current frame (R)"
                        className={`p-1 rounded transition-colors ${
                          realigningPlayerId === player.id
                            ? 'text-amber-300 bg-amber-500/20'
                            : 'text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10'
                        }`}
                      >
                        <Crosshair className="w-3 h-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onTogglePlayerVisibility(player.id);
                      }}
                      title={player.visible ? 'Hide overlay' : 'Show overlay'}
                      className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-[#1E2936] transition-colors"
                    >
                      {player.visible ? (
                        <Eye className="w-3 h-3" />
                      ) : (
                        <EyeOff className="w-3 h-3" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeletePlayer(player.id);
                      }}
                      title="Erase tool from registered video data"
                      className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                    >
                      <Eraser className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* Status + Telemetry row (Unboxed clean metadata, color paired with text/icon) */}
                {(() => {
                  const effIn = player.inTime ?? player.anchorTime;
                  const effOut =
                    player.stopTime ?? (duration > 0 ? duration : Math.max(effIn, currentTime));
                  const spanDur = Math.max(0, effOut - effIn);
                  const isBeforeIn = currentTime + 0.03 < effIn;
                  const isAfterStop =
                    player.stopTime !== undefined && currentTime > player.stopTime + 0.03;

                  return (
                    <>
                      <div className="mt-1.5 flex items-center justify-between gap-1.5 text-[10px]">
                        <StatusReadout
                          status={isAfterStop ? 'stopped' : pos.status}
                          stopReason={player.stopReason}
                          isBeforeIn={isBeforeIn}
                          isStatic={player.trackWithCv === false}
                          isSpotlight={player.style === 'spotlight'}
                          isRing={player.style === 'foot-ring'}
                          isChain={player.style === 'chain'}
                          isLinkedChain={Boolean(player.style === 'chain' && player.linkedRingIds)}
                          isPolygon={player.style === 'polygon'}
                        />
                        <span className="font-mono tabular-nums text-slate-400">
                          {isAfterStop
                            ? 'Ended'
                            : isBeforeIn
                              ? 'Standby'
                              : player.style === 'chain' && player.linkedRingIds
                                ? `${player.linkedRingIds.length} Rings`
                                : player.trackWithCv === false
                                  ? 'Pinned'
                                  : (player.style === 'chain' || player.style === 'polygon') && player.nodes
                                    ? `${player.nodes.length}${player.style === 'chain' ? 'R' : 'V'} · ${confPct}%`
                                    : `Conf ${confPct}%`}
                        </span>
                      </div>

                      <div className="mt-1 flex items-center justify-between gap-1 text-[9.5px] font-mono tabular-nums text-slate-400">
                        <div className="flex items-center gap-0.5 min-w-0 truncate">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onJumpToAnchor(effIn);
                            }}
                            title="Jump to tool start (In)"
                            className="text-slate-300 hover:text-emerald-400 underline-offset-2 hover:underline"
                          >
                            {formatTimecode(effIn)}
                          </button>
                          <span className="text-slate-600" aria-hidden="true">
                            →
                          </span>
                          {player.stopTime !== undefined ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onJumpToAnchor(player.stopTime!);
                              }}
                              title={
                                player.stopReason === 'out-of-frame'
                                  ? 'Player went out of camera here — click to jump'
                                  : 'Tool Out-point — click to jump'
                              }
                              className="text-rose-300 hover:text-rose-200 underline-offset-2 hover:underline"
                            >
                              {formatTimecode(player.stopTime)}
                            </button>
                          ) : (
                            <span className="text-slate-400">
                              {duration > 0 ? formatTimecode(duration) : 'End'}
                            </span>
                          )}
                          <span className="text-slate-500">({spanDur.toFixed(1)}s)</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {player.keyframes.length > 1 && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onJumpToAnchor(player.keyframes[player.keyframes.length - 1].time);
                              }}
                              title="Jump to latest manual realignment frame"
                              className="text-amber-300 hover:text-amber-200 underline-offset-2 hover:underline"
                            >
                              Fix {formatTimecode(player.keyframes[player.keyframes.length - 1].time)}
                            </button>
                          )}
                        </div>
                      </div>
                    </>
                  );
                })()}

                {/* Expanded Color, Style & Spotlight controls when selected */}
                {isSelected && (
                  <div className="mt-2 pt-2 border-t border-[#243040] space-y-2">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="text-[10px] text-slate-400">
                        {player.style === 'spotlight'
                          ? 'Beam Color'
                          : player.style === 'foot-ring'
                            ? 'Ring Color'
                            : player.style === 'chain'
                              ? 'Chain Color'
                              : player.style === 'polygon'
                                ? 'Border Color'
                                : 'Box Color'}
                      </span>
                      <div className="flex items-center gap-1">
                        {(player.style === 'spotlight'
                          ? SPOTLIGHT_COLORS
                          : player.style === 'foot-ring' || player.style === 'chain'
                            ? RING_COLORS
                            : player.style === 'polygon'
                              ? POLYGON_COLORS
                              : PLAYER_COLORS
                        ).map((c) => (
                          <button
                            key={c.hex}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onChangePlayerColor(player.id, c.hex);
                            }}
                            title={c.name}
                            style={{ backgroundColor: c.hex }}
                            className={`w-3.5 h-3.5 rounded-full transition-transform ${
                              player.color.toUpperCase() === c.hex.toUpperCase()
                                ? 'ring-2 ring-white ring-offset-1 ring-offset-[#17202C] scale-110'
                                : 'opacity-75 hover:opacity-100'
                            }`}
                          />
                        ))}
                        {(player.style === 'foot-ring' ||
                          player.style === 'chain' ||
                          player.style === 'polygon') && (
                          <input
                            type="color"
                            value={player.color}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              e.stopPropagation();
                              onChangePlayerColor(player.id, e.target.value);
                            }}
                            title="Custom color"
                            aria-label="Custom color"
                            className="w-4 h-4 rounded border border-[#2C3A4D] bg-[#0D1218] p-0.5 cursor-pointer"
                          />
                        )}
                      </div>
                    </div>

                    {player.style !== 'chain' && player.style !== 'polygon' && (
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-[10px] text-slate-400">Style</span>
                        <div className="flex items-center flex-wrap gap-0.5 p-0.5 bg-[#0D1218] rounded border border-[#243040]">
                          {(
                            [
                              { id: 'ring', label: 'Box' },
                              { id: 'spotlight', label: 'Spotlight' },
                              { id: 'foot-ring', label: '3D Ring' },
                            ] as const
                          ).map((st) => (
                            <button
                              key={st.id}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onChangePlayerStyle(player.id, st.id);
                              }}
                              className={`px-1.5 py-0.5 text-[10px] rounded transition-colors whitespace-nowrap ${
                                player.style === st.id
                                  ? 'bg-[#1D2735] text-slate-100 font-medium'
                                  : 'text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              {st.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {player.style === 'spotlight' && (() => {
                      const sp = player.spotlight ?? { beamSize: 80, intensity: 0.4, rotation: 0.9 };
                      return (
                        <div
                          className="space-y-1.5 pt-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Beam Size</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {sp.beamSize}px
                              </span>
                            </div>
                            <input
                              type="range"
                              min={30}
                              max={150}
                              step={2}
                              value={sp.beamSize}
                              onChange={(e) =>
                                onUpdatePlayerSpotlight(player.id, {
                                  ...sp,
                                  beamSize: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Intensity</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {sp.intensity.toFixed(2)}
                              </span>
                            </div>
                            <input
                              type="range"
                              min={0.1}
                              max={1}
                              step={0.05}
                              value={sp.intensity}
                              onChange={(e) =>
                                onUpdatePlayerSpotlight(player.id, {
                                  ...sp,
                                  intensity: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Rotation (X)</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {sp.rotation.toFixed(2)}
                              </span>
                            </div>
                            <input
                              type="range"
                              min={0.2}
                              max={1}
                              step={0.05}
                              value={sp.rotation}
                              onChange={(e) =>
                                onUpdatePlayerSpotlight(player.id, {
                                  ...sp,
                                  rotation: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <label className="flex items-center justify-between gap-2 cursor-pointer pt-0.5">
                            <span className="text-[10px] text-slate-300">Follow Player (CV)</span>
                            <input
                              type="checkbox"
                              checked={player.trackWithCv !== false}
                              onChange={() => onTogglePlayerTrackWithCv(player.id)}
                              className="accent-emerald-500 w-3 h-3 rounded"
                            />
                          </label>
                        </div>
                      );
                    })()}

                    {player.style === 'foot-ring' && (() => {
                      const rp = player.ring ?? {
                        ringSize: 112,
                        ringThickness: DEFAULT_RING_THICKNESS,
                        tiltDeg: 58,
                        spinSpeed: 2.35,
                      };
                      const thicknessPct = rp.ringThickness ?? DEFAULT_RING_THICKNESS;
                      return (
                        <div
                          className="space-y-1.5 pt-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Ring Size</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {rp.ringSize}px
                              </span>
                            </div>
                            <input
                              type="range"
                              min={MIN_RING_SIZE}
                              max={MAX_RING_SIZE}
                              step={2}
                              value={rp.ringSize}
                              onChange={(e) =>
                                onUpdatePlayerRing(player.id, {
                                  ...rp,
                                  ringSize: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Thickness</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {thicknessPct}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min={MIN_RING_THICKNESS}
                              max={MAX_RING_THICKNESS}
                              step={2}
                              value={thicknessPct}
                              onChange={(e) =>
                                onUpdatePlayerRing(player.id, {
                                  ...rp,
                                  ringThickness: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Tilt</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {rp.tiltDeg}°
                              </span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={75}
                              step={1}
                              value={rp.tiltDeg}
                              onChange={(e) =>
                                onUpdatePlayerRing(player.id, {
                                  ...rp,
                                  tiltDeg: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Spin Cycle</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {rp.spinSpeed.toFixed(2)}s
                              </span>
                            </div>
                            <input
                              type="range"
                              min={1.0}
                              max={5.0}
                              step={0.05}
                              value={rp.spinSpeed}
                              onChange={(e) =>
                                onUpdatePlayerRing(player.id, {
                                  ...rp,
                                  spinSpeed: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <label className="flex items-center justify-between gap-2 cursor-pointer pt-0.5">
                            <span className="text-[10px] text-slate-300">Follow Player (CV)</span>
                            <input
                              type="checkbox"
                              checked={player.trackWithCv !== false}
                              onChange={() => onTogglePlayerTrackWithCv(player.id)}
                              className="accent-emerald-500 w-3 h-3 rounded"
                            />
                          </label>
                        </div>
                      );
                    })()}

                    {player.style === 'chain' && (() => {
                      const cp = player.chain ?? {
                        ringSize: 112,
                        ringThickness: DEFAULT_RING_THICKNESS,
                        tiltDeg: 58,
                        spinSpeed: 2.35,
                        connectorWidth: 10,
                        dashed: false,
                      };
                      if (player.linkedRingIds) {
                        const linkedLabels = player.linkedRingIds.map((rid) => {
                          const found = players.find((r) => r.id === rid);
                          return { id: rid, label: found?.label ?? 'Ring', color: found?.color ?? player.color };
                        });
                        return (
                          <div
                            className="space-y-2 pt-0.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div>
                              <div className="text-[9.5px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                                Linked 3D Rings ({linkedLabels.length})
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {linkedLabels.map((item, idx) => (
                                  <button
                                    key={`${item.id}_${idx}`}
                                    type="button"
                                    onClick={() => onSelectPlayer(item.id)}
                                    title={`Select ${item.label}`}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#0D1218] hover:bg-[#17212E] border border-[#243040] text-[10px] text-slate-200 transition-colors"
                                  >
                                    <span
                                      className="w-2 h-2 rounded-full shrink-0"
                                      style={{ backgroundColor: item.color }}
                                    />
                                    <span className="truncate max-w-[90px]">{item.label}</span>
                                  </button>
                                ))}
                              </div>
                            </div>

                            <div>
                              <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                                <span>Link Width</span>
                                <span className="font-mono tabular-nums text-slate-200">
                                  {cp.connectorWidth}px
                                </span>
                              </div>
                              <input
                                type="range"
                                min={3}
                                max={26}
                                step={1}
                                value={cp.connectorWidth}
                                onChange={(e) =>
                                  onUpdatePlayerChain(player.id, {
                                    ...cp,
                                    connectorWidth: Number(e.target.value),
                                  })
                                }
                                className="pitch-slider w-full"
                              />
                            </div>

                            <label className="flex items-center justify-between gap-2 cursor-pointer pt-0.5">
                              <span className="text-[10px] text-slate-300">Dashed Link</span>
                              <input
                                type="checkbox"
                                checked={Boolean(cp.dashed)}
                                onChange={(e) =>
                                  onUpdatePlayerChain(player.id, {
                                    ...cp,
                                    dashed: e.target.checked,
                                  })
                                }
                                className="accent-cyan-400 w-3 h-3 rounded"
                              />
                            </label>
                          </div>
                        );
                      }

                      const thicknessPct = cp.ringThickness ?? DEFAULT_RING_THICKNESS;
                      return (
                        <div
                          className="space-y-1.5 pt-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Ring Size</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {cp.ringSize}px
                              </span>
                            </div>
                            <input
                              type="range"
                              min={MIN_RING_SIZE}
                              max={MAX_RING_SIZE}
                              step={2}
                              value={cp.ringSize}
                              onChange={(e) =>
                                onUpdatePlayerChain(player.id, {
                                  ...cp,
                                  ringSize: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Ring Thickness</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {thicknessPct}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min={MIN_RING_THICKNESS}
                              max={MAX_RING_THICKNESS}
                              step={2}
                              value={thicknessPct}
                              onChange={(e) =>
                                onUpdatePlayerChain(player.id, {
                                  ...cp,
                                  ringThickness: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Tilt</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {cp.tiltDeg}°
                              </span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={75}
                              step={1}
                              value={cp.tiltDeg}
                              onChange={(e) =>
                                onUpdatePlayerChain(player.id, {
                                  ...cp,
                                  tiltDeg: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Spin Cycle</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {cp.spinSpeed.toFixed(2)}s
                              </span>
                            </div>
                            <input
                              type="range"
                              min={1.0}
                              max={5.0}
                              step={0.05}
                              value={cp.spinSpeed}
                              onChange={(e) =>
                                onUpdatePlayerChain(player.id, {
                                  ...cp,
                                  spinSpeed: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Link Width</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {cp.connectorWidth}px
                              </span>
                            </div>
                            <input
                              type="range"
                              min={3}
                              max={26}
                              step={1}
                              value={cp.connectorWidth}
                              onChange={(e) =>
                                onUpdatePlayerChain(player.id, {
                                  ...cp,
                                  connectorWidth: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <label className="flex items-center justify-between gap-2 cursor-pointer pt-0.5">
                            <span className="text-[10px] text-slate-300">Follow Players (CV)</span>
                            <input
                              type="checkbox"
                              checked={player.trackWithCv !== false}
                              onChange={() => onTogglePlayerTrackWithCv(player.id)}
                              className="accent-emerald-500 w-3 h-3 rounded"
                            />
                          </label>
                        </div>
                      );
                    })()}

                    {player.style === 'polygon' && (() => {
                      const pp = player.polygon ?? {
                        borderColor: player.color,
                        borderThickness: 3,
                        dashedBorder: false,
                        fillColor: player.color,
                        fillOpacity: 0.2,
                        markerSize: 5,
                      };
                      return (
                        <div
                          className="space-y-1.5 pt-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] text-slate-400">Fill Color</span>
                            <input
                              type="color"
                              value={pp.fillColor}
                              onChange={(e) =>
                                onUpdatePlayerPolygon(player.id, {
                                  ...pp,
                                  fillColor: e.target.value,
                                })
                              }
                              aria-label="Polygon Fill Color"
                              className="w-5 h-4 rounded border border-[#2C3A4D] bg-[#0D1218] p-0.5 cursor-pointer"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Border Width</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {pp.borderThickness}px
                              </span>
                            </div>
                            <input
                              type="range"
                              min={1}
                              max={10}
                              step={1}
                              value={pp.borderThickness}
                              onChange={(e) =>
                                onUpdatePlayerPolygon(player.id, {
                                  ...pp,
                                  borderThickness: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Fill Opacity</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {Math.round(pp.fillOpacity * 100)}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={0.8}
                              step={0.05}
                              value={pp.fillOpacity}
                              onChange={(e) =>
                                onUpdatePlayerPolygon(player.id, {
                                  ...pp,
                                  fillOpacity: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Vertex Marker</span>
                              <span className="font-mono tabular-nums text-slate-200">
                                {pp.markerSize}px
                              </span>
                            </div>
                            <input
                              type="range"
                              min={3}
                              max={12}
                              step={1}
                              value={pp.markerSize}
                              onChange={(e) =>
                                onUpdatePlayerPolygon(player.id, {
                                  ...pp,
                                  markerSize: Number(e.target.value),
                                })
                              }
                              className="pitch-slider w-full"
                            />
                          </div>

                          <label className="flex items-center justify-between gap-2 cursor-pointer pt-0.5">
                            <span className="text-[10px] text-slate-300">Dashed Border</span>
                            <input
                              type="checkbox"
                              checked={pp.dashedBorder}
                              onChange={(e) =>
                                onUpdatePlayerPolygon(player.id, {
                                  ...pp,
                                  dashedBorder: e.target.checked,
                                })
                              }
                              className="accent-rose-500 w-3 h-3 rounded"
                            />
                          </label>

                          <label className="flex items-center justify-between gap-2 cursor-pointer pt-0.5">
                            <span className="text-[10px] text-slate-300">Follow Vertices (CV)</span>
                            <input
                              type="checkbox"
                              checked={player.trackWithCv !== false}
                              onChange={() => onTogglePlayerTrackWithCv(player.id)}
                              className="accent-emerald-500 w-3 h-3 rounded"
                            />
                          </label>
                        </div>
                      );
                    })()}

                    {(player.style === 'chain' || player.style === 'polygon') &&
                      player.nodes &&
                      player.nodes.length > 0 && (
                        <div
                          className="space-y-1 pt-1 border-t border-[#223042]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="text-[9.5px] font-semibold uppercase tracking-wide text-slate-400">
                            {player.style === 'chain' ? 'Chain Rings' : 'Polygon Vertices'} (
                            {player.nodes.length})
                          </div>
                          <div className="max-h-28 overflow-y-auto space-y-0.5 pr-0.5">
                            {player.nodes.map((node) => {
                              const isNodeSel = node.id === selectedNodeId;
                              const isNodeRealign =
                                realigningPlayerId === player.id && realigningNodeId === node.id;
                              return (
                                <div
                                  key={node.id}
                                  onClick={() => {
                                    onSelectPlayer(player.id);
                                    onSelectNode(node.id);
                                  }}
                                  className={`flex items-center justify-between gap-1 px-1.5 py-0.5 rounded text-[10px] cursor-pointer transition-colors ${
                                    isNodeSel
                                      ? 'bg-[#1D2B3B] text-slate-100'
                                      : 'bg-[#0F151E] hover:bg-[#17212E] text-slate-300'
                                  }`}
                                >
                                  <span className="truncate font-medium">{node.label}</span>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <span className="font-mono text-[9px] text-slate-400">
                                      {node.currentPosition.status === 'stopped'
                                        ? 'Stop'
                                        : `${Math.round(node.currentPosition.confidence * 100)}%`}
                                    </span>
                                    {player.trackWithCv !== false && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (isNodeRealign) {
                                            onCancelRealign();
                                          } else {
                                            onSelectNode(node.id);
                                            onStartRealign(player.id, node.id);
                                          }
                                        }}
                                        title={`Realign ${node.label}`}
                                        className={`p-0.5 rounded transition-colors ${
                                          isNodeRealign
                                            ? 'bg-amber-500/25 text-amber-300'
                                            : 'text-slate-400 hover:text-emerald-400'
                                        }`}
                                      >
                                        <Crosshair className="w-2.5 h-2.5" />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                    {player.trackWithCv !== false && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (realigningPlayerId === player.id) {
                            onCancelRealign();
                          } else {
                            onStartRealign(player.id);
                          }
                        }}
                        className={`w-full flex items-center justify-center gap-1 py-1 px-2 rounded text-[10px] font-medium border transition-colors ${
                          realigningPlayerId === player.id
                            ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                            : 'bg-[#121821] hover:bg-[#1B2432] border-[#263344] text-slate-200'
                        }`}
                      >
                        <Crosshair className="w-3 h-3" />
                        <span>
                          {realigningPlayerId === player.id
                            ? 'Click real player on video (Esc)'
                            : 'Realign Frame (R)'}
                        </span>
                      </button>
                    )}

                    <div className="grid grid-cols-2 gap-1">
                      {!isAtOrAfterStop ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onStopTrackingPlayer(player.id);
                          }}
                          title="Stop tracking from current frame while keeping tracked data"
                          className="flex items-center justify-center gap-1 py-1 px-1.5 rounded text-[10px] font-medium border bg-[#121821] hover:bg-amber-500/10 border-[#263344] hover:border-amber-500/40 text-slate-200 hover:text-amber-200 transition-colors"
                        >
                          <Square className="w-2.5 h-2.5" />
                          <span>Stop Here</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isAtClipEnd}
                          onClick={(e) => {
                            e.stopPropagation();
                            onResumeTrackingPlayer(player.id);
                          }}
                          title={
                            isAtClipEnd
                              ? 'Already tracks to end of video'
                              : 'Add another 10 seconds of tracking past stop point'
                          }
                          className="flex items-center justify-center gap-1 py-1 px-1.5 rounded text-[10px] font-medium border bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/35 text-emerald-300 transition-colors disabled:opacity-40"
                        >
                          <Play className="w-2.5 h-2.5" />
                          <span>Resume +10s</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeletePlayer(player.id);
                        }}
                        title="Erase tool completely from registered video data"
                        className="flex items-center justify-center gap-1 py-1 px-1.5 rounded text-[10px] font-medium border bg-[#121821] hover:bg-rose-500/10 border-[#263344] hover:border-rose-500/40 text-slate-200 hover:text-rose-300 transition-colors"
                      >
                        <Eraser className="w-2.5 h-2.5" />
                        <span>Erase Tool</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

    </aside>
  );
};

const StatusReadout: React.FC<{
  status: TrackingStatus;
  stopReason?: 'manual' | 'out-of-frame';
  isBeforeIn?: boolean;
  isStatic?: boolean;
  isSpotlight?: boolean;
  isRing?: boolean;
  isChain?: boolean;
  isLinkedChain?: boolean;
  isPolygon?: boolean;
}> = ({
  status,
  stopReason,
  isBeforeIn,
  isStatic,
  isSpotlight,
  isRing,
  isChain,
  isLinkedChain,
  isPolygon,
}) => {
  if (status === 'stopped') {
    return (
      <span className="inline-flex items-center gap-1 text-rose-300 font-medium">
        <Square className="w-3 h-3" />
        <span>{stopReason === 'out-of-frame' ? 'Out of Cam · Stopped' : 'Tracking Stopped'}</span>
      </span>
    );
  }
  if (isBeforeIn) {
    return (
      <span className="inline-flex items-center gap-1 text-slate-400 font-medium">
        <Target className="w-3 h-3 text-slate-500" />
        <span>Before In-Point</span>
      </span>
    );
  }
  if (isChain && isLinkedChain) {
    return (
      <span className="inline-flex items-center gap-1 text-cyan-300 font-medium">
        <Link2 className="w-3 h-3 text-cyan-300" />
        <span>Chain Linked</span>
      </span>
    );
  }
  if (isStatic) {
    return (
      <span className="inline-flex items-center gap-1 text-slate-300 font-medium">
        <Pin className="w-3 h-3 text-amber-300" />
        <span>
          {isChain
            ? 'Static Chain'
            : isPolygon
              ? 'Static Polygon'
              : isRing
                ? 'Static Ring'
                : 'Static Spotlight'}
        </span>
      </span>
    );
  }
  if (status === 'tracking') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
        {isSpotlight ? (
          <Sun className="w-3 h-3" />
        ) : isRing ? (
          <Disc className="w-3 h-3 text-cyan-300" />
        ) : isChain ? (
          <Link2 className="w-3 h-3 text-cyan-300" />
        ) : isPolygon ? (
          <Pentagon className="w-3 h-3 text-rose-400" />
        ) : (
          <CheckCircle2 className="w-3 h-3" />
        )}
        <span>
          {isSpotlight
            ? 'Spotlight Locked'
            : isRing
              ? 'Ring Locked'
              : isChain
                ? 'Chain Locked'
                : isPolygon
                  ? 'Polygon Locked'
                  : 'Tracking Locked'}
        </span>
      </span>
    );
  }
  if (status === 'anchored') {
    return (
      <span className="inline-flex items-center gap-1 text-cyan-400 font-medium">
        {isSpotlight ? (
          <Sun className="w-3 h-3 text-amber-300" />
        ) : isRing ? (
          <Disc className="w-3 h-3 text-cyan-300" />
        ) : isChain ? (
          <Link2 className="w-3 h-3 text-cyan-300" />
        ) : isPolygon ? (
          <Pentagon className="w-3 h-3 text-rose-400" />
        ) : (
          <Target className="w-3 h-3" />
        )}
        <span>
          {isSpotlight
            ? 'Spotlight Anchored'
            : isRing
              ? 'Ring Anchored'
              : isChain
                ? 'Chain Anchored'
                : isPolygon
                  ? 'Polygon Anchored'
                  : 'Anchored'}
        </span>
      </span>
    );
  }
  if (status === 'occluded') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
        <AlertTriangle className="w-3 h-3" />
        <span>Occluded / Coasting</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-rose-400 font-medium">
      <AlertTriangle className="w-3 h-3" />
      <span>Lost Target</span>
    </span>
  );
};
