"use client";

import { CameraFormDialog } from "@/components/cameras/CameraFormDialog";
import { useAuth } from "@/hooks/useAuth";
import { useSocket } from "@/hooks/useSocket";
import { api } from "@/lib/api";
import { cn, formatBytes, formatDate, formatResolution, getStatusColor } from "@/lib/utils";
import { Camera, PaginatedResponse } from "@/types";
import {
  AlertCircle,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export default function CamerasPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [activationFilter, setActivationFilter] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editCamera, setEditCamera] = useState<Camera | undefined>();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [pendingActivation, setPendingActivation] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Bumped to force a re-measurement of storage on the next fetch. */
  const [storageNonce, setStorageNonce] = useState(0);
  const limit = 10;

  // Admin and Manager may edit cameras; deletion stays Admin-only (backend).
  const canEdit = !user || user.role === "Admin" || user.role === "Manager";
  const canDelete = !user || user.role === "Admin";

  const fetchCameras = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
        ...(search && { search }),
        ...(statusFilter && { status: statusFilter }),
        ...(activationFilter && { activation: activationFilter }),
        ...(storageNonce > 0 && { refreshStorage: "1" }),
      });
      const res = await api.get<PaginatedResponse<Camera>>(`/cameras?${params}`);
      if (res.success) {
        setCameras(res.data);
        setTotal(res.meta.total);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("events.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter, activationFilter, storageNonce, t]);

  useEffect(() => {
    fetchCameras();
  }, [fetchCameras]);

  const handleDelete = async (id: string) => {
    if (!confirm(t("cameras.deleteConfirm"))) return;
    try {
      await api.delete(`/cameras/${id}`);
      fetchCameras();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("cameras.activationFailed"));
    }
  };

  /**
   * Administrative on/off switch. Separate from delete: the camera stays listed,
   * keeps its modules/ROI/history and can be switched back on at any time.
   */
  const toggleActivation = async (camera: Camera) => {
    const next = !camera.isActive;
    if (!next && !confirm(t("cameras.activationConfirm"))) return;

    setPendingActivation(camera.id);
    setActionError(null);
    try {
      const res = await api.patch<{ success: boolean; data: Camera }>(
        `/cameras/${camera.id}/activation`,
        { isActive: next },
      );
      if (res.success) {
        // Optimistic merge keeps the row stable while the list refetches.
        setCameras((prev) =>
          prev.map((cam) =>
            cam.id === camera.id ? { ...cam, isActive: res.data.isActive, updatedAt: res.data.updatedAt } : cam,
          ),
        );
      }
      fetchCameras();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("cameras.activationFailed"));
    } finally {
      setPendingActivation(null);
    }
  };

  const statusIcon = (status: string) => {
    if (status === "ONLINE") return <Wifi className="w-3.5 h-3.5" />;
    if (status === "OFFLINE") return <WifiOff className="w-3.5 h-3.5" />;
    return <AlertCircle className="w-3.5 h-3.5" />;
  };

  /** Storage cell: measured bytes, or an explicit non-zero state. */
  const renderStorage = (cam: Camera) => {
    const storage = cam.storage;
    const status = storage?.measurementStatus;

    if (!storage || status === "calculating") {
      return (
        <span className="text-xs text-gray-500 animate-pulse" title={t("cameras.storageCalculating")}>
          {t("cameras.storageCalculating")}
        </span>
      );
    }

    if (status === "unavailable" || storage.bytes === null) {
      return (
        <span className="text-xs text-amber-500/90" title={storage.reason ?? undefined}>
          {t("cameras.storageUnavailable")}
        </span>
      );
    }

    return (
      <div className="flex flex-col">
        <span
          className={cn(
            "font-mono text-xs font-bold",
            storage.bytes === 0 ? "text-gray-500" : "text-amber-400",
          )}
        >
          {formatBytes(storage.bytes)}
        </span>
        {storage.calculatedAt && (
          <span className="text-[10px] text-gray-600">
            {t("cameras.storageMeasuredAt", { time: formatDate(storage.calculatedAt) })}
          </span>
        )}
      </div>
    );
  };

  // Another admin may switch a camera on/off from a different tab: keep this
  // list in sync instead of waiting for a manual refresh.
  const handleRemoteActivation = useCallback(
    (payload: { id: string; isActive: boolean }) => {
      setCameras((prev) =>
        prev.map((cam) => (cam.id === payload.id ? { ...cam, isActive: payload.isActive } : cam)),
      );
    },
    [],
  );

  useSocket(undefined, undefined, undefined, handleRemoteActivation);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{t("cameras.title")}</h1>
          <p className="text-gray-400 text-sm mt-1">
            {t("cameras.registered", { total })}
          </p>
        </div>
        <button
          onClick={() => {
            setEditCamera(undefined);
            setShowForm(true);
          }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2.5 rounded-lg transition text-sm"
        >
          <Plus className="w-4 h-4" />
          {t("cameras.addCamera")}
        </button>
      </div>

      {actionError && (
        <div className="bg-red-900/30 border border-red-800 text-red-300 rounded-lg px-3 py-2.5 text-sm">
          {actionError}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t("cameras.searchPlaceholder")}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-4 py-2.5 text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          <option value="">{t("cameras.allStatus")}</option>
          <option value="ONLINE">{t("cameras.statusOnline")}</option>
          <option value="OFFLINE">{t("cameras.statusOffline")}</option>
          <option value="ERROR">{t("cameras.statusError")}</option>
        </select>
        <select
          value={activationFilter}
          onChange={(e) => {
            setActivationFilter(e.target.value);
            setPage(1);
          }}
          aria-label={t("cameras.colActive")}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          <option value="">{t("cameras.activationFilterAll")}</option>
          <option value="active">{t("cameras.activationFilterActive")}</option>
          <option value="inactive">{t("cameras.activationFilterInactive")}</option>
        </select>
        <button
          onClick={fetchCameras}
          className="p-2.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white transition"
          title={t("common.refresh")}
        >
          <RefreshCw className="w-4 h-4" />
        </button>
        <button
          onClick={() => setStorageNonce((n) => n + 1)}
          className="p-2.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white transition"
          title={t("cameras.storageRefresh")}
        >
          <RefreshCw className="w-4 h-4 opacity-60" />
        </button>
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-950/50">
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  {t("cameras.colName")}
                </th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  {t("cameras.colLocation")}
                </th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  {t("cameras.colResolution")}
                </th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  {t("cameras.colStorage")}
                </th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  {t("cameras.colStatus")}
                </th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  {t("cameras.colActive")}
                </th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  {t("cameras.colModules")}
                </th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  {t("cameras.colCreated")}
                </th>
                <th className="text-right px-4 py-3.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  {t("cameras.colActions")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <td key={j} className="px-4 py-4">
                        <div className="h-4 bg-gray-800 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : cameras.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-center py-12 text-gray-500">
                    {t("cameras.noCameras")}
                  </td>
                </tr>
              ) : (
                cameras.map((cam) => {
                  const resolutionLabel = formatResolution(cam.resolution);
                  return (
                    <tr
                      key={cam.id}
                      className={cn(
                        "hover:bg-gray-800/40 transition",
                        !cam.isActive && "opacity-70",
                      )}
                    >
                      <td className="px-4 py-4 font-medium text-white">
                        {cam.name}
                      </td>
                      <td className="px-4 py-4 text-gray-300">{cam.location}</td>
                      <td className="px-4 py-4">
                        {resolutionLabel ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">
                            {resolutionLabel}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-500" title={t("cameras.resolutionUnknown")}>
                            {t("cameras.resolutionUnknown")}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-4">{renderStorage(cam)}</td>
                      <td className="px-4 py-4">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border",
                            getStatusColor(cam.status),
                          )}
                        >
                          {statusIcon(cam.status)}
                          {cam.status === "ONLINE" ? t("cameras.statusOnline") : cam.status === "OFFLINE" ? t("cameras.statusOffline") : t("cameras.statusError")}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <button
                          type="button"
                          onClick={() => toggleActivation(cam)}
                          disabled={!canEdit || pendingActivation === cam.id}
                          title={cam.isActive ? t("cameras.deactivate") : t("cameras.activate")}
                          className={cn(
                            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition disabled:opacity-40 disabled:cursor-not-allowed",
                            cam.isActive
                              ? "bg-emerald-500/15 text-emerald-300 border-emerald-600/40 hover:bg-emerald-500/25"
                              : "bg-gray-700/30 text-gray-400 border-gray-600 hover:bg-gray-700/50",
                          )}
                        >
                          {cam.isActive ? (
                            <Power className="w-3.5 h-3.5" />
                          ) : (
                            <PowerOff className="w-3.5 h-3.5" />
                          )}
                          {cam.isActive ? t("cameras.statusActive") : t("cameras.statusInactive")}
                        </button>
                      </td>
                      <td className="px-4 py-4 text-gray-300">
                        {t("cameras.modulesCount", {
                          count: cam.cameraModules?.length ?? 0,
                        })}
                      </td>
                      <td className="px-4 py-4 text-gray-400 text-xs">
                        {formatDate(cam.createdAt)}
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => {
                              setEditCamera(cam);
                              setShowForm(true);
                            }}
                            className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-400/10 rounded transition"
                            title={t("common.saveChanges")}
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          {canDelete && (
                            <button
                              onClick={() => handleDelete(cam.id)}
                              className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded transition"
                              title={t("cameras.deleteConfirm")}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
            <p className="text-xs text-gray-400">
              {t("common.showingRange", {
                from: (page - 1) * limit + 1,
                to: Math.min(page * limit, total),
                total,
              })}
            </p>
            <div className="flex gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 text-xs bg-gray-800 text-gray-300 rounded hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {t("common.previous")}
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1.5 text-xs bg-gray-800 text-gray-300 rounded hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {t("common.next")}
              </button>
            </div>
          </div>
        )}
      </div>

      {showForm && (
        <CameraFormDialog
          camera={editCamera}
          onClose={() => setShowForm(false)}
          onSuccess={() => {
            setShowForm(false);
            fetchCameras();
          }}
        />
      )}
    </div>
  );
}
