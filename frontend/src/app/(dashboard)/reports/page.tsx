"use client";

import { api } from "@/lib/api";
import {
  APP_TIME_ZONE,
  formatDateKey,
  formatDayMonth,
  formatMonthLabel,
  formatWeekRange,
  isValidDateKey,
  monthInputValue,
  parseMonthInput,
  shiftDateKey,
  shiftMonth,
  todayKey,
} from "@/lib/datetime";
import {
  ApiResponse,
  DailyReport,
  MonthlyReport,
  PaginatedResponse,
  Event,
  WeeklyReport,
} from "@/types";
import {
  Activity,
  AlertCircle,
  BarChart2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  PieChart as PieIcon,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Period = "daily" | "weekly" | "monthly";

const COLORS = ["#2563eb", "#dc2626", "#d97706", "#16a34a", "#9333ea", "#0891b2"];

/** CSV cell: escaped, and hardened against spreadsheet formula injection. */
function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

const tooltipStyle = {
  backgroundColor: "#111827",
  border: "1px solid #1f2937",
  borderRadius: "8px",
  color: "#f9fafb",
  fontSize: "12px",
};

export default function ReportsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === "en" ? "en-GB" : "vi-VN";

  const [period, setPeriod] = useState<Period>("daily");
  // Each period keeps its own data so switching never shows another period's
  // numbers under the new label.
  const [dailyReport, setDailyReport] = useState<DailyReport | null>(null);
  const [weeklyReport, setWeeklyReport] = useState<WeeklyReport | null>(null);
  const [monthlyReport, setMonthlyReport] = useState<MonthlyReport | null>(null);

  const [selectedDate, setSelectedDate] = useState(() => todayKey());
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const key = todayKey();
    return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) };
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);

  /** Ignore responses that arrive after the user switched period. */
  const requestId = useRef(0);

  const fetchReport = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    setEmpty(false);

    try {
      if (period === "daily") {
        const res = await api.get<ApiResponse<DailyReport>>(`/reports/daily?date=${selectedDate}`);
        if (id !== requestId.current) return;
        if (!res.success) throw new Error(res.message ?? t("reports.loadFailed"));
        setDailyReport(res.data);
        setEmpty(res.data.totalEvents === 0);
      } else if (period === "weekly") {
        const res = await api.get<ApiResponse<WeeklyReport>>(`/reports/weekly?date=${selectedDate}`);
        if (id !== requestId.current) return;
        if (!res.success) throw new Error(res.message ?? t("reports.loadFailed"));
        setWeeklyReport(res.data);
        setEmpty(res.data.totalEvents === 0);
      } else {
        const res = await api.get<ApiResponse<MonthlyReport>>(
          `/reports/monthly?year=${selectedMonth.year}&month=${selectedMonth.month}`,
        );
        if (id !== requestId.current) return;
        if (!res.success) throw new Error(res.message ?? t("reports.loadFailed"));
        setMonthlyReport(res.data);
        setEmpty(res.data.totalEvents === 0);
      }
    } catch (err) {
      if (id !== requestId.current) return;
      // An API failure is NOT an empty report: clear the stale data and say so.
      setError(err instanceof Error ? err.message : t("reports.loadFailed"));
      if (period === "daily") setDailyReport(null);
      else if (period === "weekly") setWeeklyReport(null);
      else setMonthlyReport(null);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [period, selectedDate, selectedMonth, t]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  // ── Derived view model ────────────────────────────────────────────────────
  const current = period === "daily" ? dailyReport : period === "weekly" ? weeklyReport : monthlyReport;

  const totals = useMemo(
    () => ({
      totalEvents: current?.totalEvents ?? 0,
      totalAlerts: current?.totalAlerts ?? 0,
      alertRate: current?.alertRate ?? 0,
    }),
    [current],
  );

  const dailySeries = useMemo(() => {
    if (period === "daily") {
      return (dailyReport?.dailyData ?? []).map((bucket) => ({
        ...bucket,
        label: formatDayMonth(bucket.date, locale),
      }));
    }
    const rows = period === "weekly" ? weeklyReport?.dailyData : monthlyReport?.dailyData;
    return (rows ?? []).map((bucket) => ({
      ...bucket,
      label: formatDayMonth(bucket.date, locale),
    }));
  }, [period, dailyReport, weeklyReport, monthlyReport, locale]);

  const typeSeries = useMemo(() => {
    if (period === "daily") {
      const list = dailyReport?.byTypeList ?? [];
      if (list.length > 0) return list.map((b) => ({ name: b.type, value: b.count }));
      return Object.entries(dailyReport?.byType ?? {}).map(([name, value]) => ({ name, value }));
    }
    const rows = period === "weekly" ? weeklyReport?.byType : monthlyReport?.byType;
    return (rows ?? []).map((b) => ({ name: b.type, value: b.count }));
  }, [period, dailyReport, weeklyReport, monthlyReport]);

  const periodLabel = useMemo(() => {
    if (period === "daily") return formatDateKey(selectedDate, locale);
    if (period === "weekly" && weeklyReport) {
      return formatWeekRange(weeklyReport.startDate, weeklyReport.endDate, locale);
    }
    if (period === "monthly") return formatMonthLabel(selectedMonth.year, selectedMonth.month, locale);
    return "";
  }, [period, selectedDate, selectedMonth, weeklyReport, locale]);

  // ── Period navigation ─────────────────────────────────────────────────────
  const stepPeriod = (direction: -1 | 1) => {
    if (period === "daily") {
      setSelectedDate((key) => shiftDateKey(key, direction));
    } else if (period === "weekly") {
      setSelectedDate((key) => shiftDateKey(key, direction * 7));
    } else {
      setSelectedMonth((m) => shiftMonth(m.year, m.month, direction));
    }
  };

  const jumpToNow = () => {
    const today = todayKey();
    setSelectedDate(today);
    setSelectedMonth({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) });
  };

  /** Jump to the most recent event instead of hunting through empty periods. */
  const jumpToLatestData = async () => {
    try {
      const res = await api.get<PaginatedResponse<Event>>("/events?page=1&limit=1");
      const latest = res.data?.[0];
      if (!latest) return;
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: APP_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(latest.timestamp));
      const pick = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((p) => p.type === type)?.value ?? "";
      const key = `${pick("year")}-${pick("month")}-${pick("day")}`;
      if (!isValidDateKey(key)) return;
      setSelectedDate(key);
      setSelectedMonth({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) });
    } catch {
      /* navigation helper only */
    }
  };

  // ── Exports ───────────────────────────────────────────────────────────────
  const exportCSV = () => {
    if (!current || totals.totalEvents === 0) {
      setError(t("reports.exportEmpty"));
      return;
    }

    const lines: string[] = [];
    lines.push(["Report", periodLabel].map(csvCell).join(","));
    lines.push(["Period", period].map(csvCell).join(","));
    lines.push(["Timezone", APP_TIME_ZONE].map(csvCell).join(","));
    lines.push(["Total events", totals.totalEvents].map(csvCell).join(","));
    lines.push(["Total alerts", totals.totalAlerts].map(csvCell).join(","));
    lines.push(["Alert rate", `${totals.alertRate.toFixed(2)}%`].map(csvCell).join(","));
    lines.push("");
    lines.push(["Date", "Events", "Alerts"].map(csvCell).join(","));
    for (const bucket of dailySeries) {
      lines.push([bucket.date, bucket.count, bucket.alerts].map(csvCell).join(","));
    }
    lines.push("");
    lines.push(["Event type", "Count"].map(csvCell).join(","));
    for (const row of typeSeries) {
      lines.push([row.name, row.value].map(csvCell).join(","));
    }

    const filename =
      period === "daily"
        ? `report_daily_${selectedDate}.csv`
        : period === "weekly" && weeklyReport
          ? `report_weekly_${weeklyReport.startDate}_${weeklyReport.endDate}.csv`
          : `report_monthly_${selectedMonth.year}-${String(selectedMonth.month).padStart(2, "0")}.csv`;

    const blob = new Blob([`\ufeff${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPDF = () => window.print();

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{t("reports.title")}</h1>
          <p className="text-gray-400 text-sm mt-1">{t("reports.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={exportCSV}
            disabled={!current || totals.totalEvents === 0}
            className="flex items-center gap-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-2 rounded-lg text-sm transition"
          >
            <Download className="w-4 h-4" />
            {t("reports.exportCsv")}
          </button>
          <button
            onClick={exportPDF}
            className="flex items-center gap-2 bg-red-700 hover:bg-red-600 text-white px-3 py-2 rounded-lg text-sm transition"
          >
            <Download className="w-4 h-4" />
            {t("reports.printPdf")}
          </button>
        </div>
      </div>

      {/* Period selector + navigation */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex bg-gray-900 border border-gray-800 rounded-lg p-1">
          {(["daily", "weekly", "monthly"] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition capitalize ${
                period === p ? "bg-blue-600 text-white" : "text-gray-400 hover:text-white"
              }`}
            >
              {t(`reports.period.${p}`)}
            </button>
          ))}
        </div>

        {/* Step to the previous/next period */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => stepPeriod(-1)}
            aria-label={t("reports.previous")}
            className="p-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white transition"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {period === "monthly" ? (
            <input
              type="month"
              value={monthInputValue(selectedMonth.year, selectedMonth.month)}
              onChange={(e) => {
                const parsed = parseMonthInput(e.target.value);
                if (parsed) setSelectedMonth(parsed);
              }}
              aria-label={t("reports.periodLabel")}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          ) : (
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => {
                if (isValidDateKey(e.target.value)) setSelectedDate(e.target.value);
              }}
              aria-label={t("reports.periodLabel")}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          )}

          <button
            onClick={() => stepPeriod(1)}
            aria-label={t("reports.next")}
            className="p-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white transition"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <button
          onClick={jumpToNow}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-300 hover:text-white text-xs transition"
        >
          {period === "daily" ? t("reports.today") : period === "weekly" ? t("reports.thisWeek") : t("reports.thisMonth")}
        </button>

        <button
          onClick={jumpToLatestData}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-300 hover:text-white text-xs transition"
        >
          {t("reports.latestData")}
        </button>

        <button
          onClick={fetchReport}
          className="p-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white transition"
          title={t("common.refresh")}
        >
          <RefreshCw className="w-4 h-4" />
        </button>

        <span className="text-xs text-gray-500">
          {t("reports.showing", { period: periodLabel })} · {APP_TIME_ZONE}
        </span>
      </div>

      {period === "weekly" && <p className="text-[11px] text-gray-600">{t("reports.weeklyHint")}</p>}
      {period === "monthly" && <p className="text-[11px] text-gray-600">{t("reports.monthlyHint")}</p>}

      {error && (
        <div className="bg-red-900/30 border border-red-800 text-red-300 rounded-lg px-3 py-2.5 text-sm flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </span>
          <button onClick={fetchReport} className="underline hover:text-red-200 transition shrink-0">
            {t("common.retry")}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : !current ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-10 text-center text-gray-500 text-sm">
          {error ? t("reports.loadFailed") : t("reports.noData")}
        </div>
      ) : (
        <>
          {/* Summary KPI cards — server-side totals for the selected period */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-xs font-medium uppercase tracking-wider">{t("reports.totalEvents")}</p>
                <p className="text-3xl font-bold text-white mt-1">{totals.totalEvents.toLocaleString()}</p>
              </div>
              <div className="p-3 bg-blue-500/10 rounded-xl text-blue-400 border border-blue-500/20">
                <Activity className="w-6 h-6" />
              </div>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-xs font-medium uppercase tracking-wider">{t("reports.totalAlerts")}</p>
                <p className="text-3xl font-bold text-red-400 mt-1">{totals.totalAlerts.toLocaleString()}</p>
              </div>
              <div className="p-3 bg-red-500/10 rounded-xl text-red-400 border border-red-500/20">
                <TrendingUp className="w-6 h-6" />
              </div>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-xs font-medium uppercase tracking-wider">{t("reports.alertRate")}</p>
                <p className="text-3xl font-bold text-yellow-400 mt-1">{totals.alertRate.toFixed(0)}%</p>
              </div>
              <div className="p-3 bg-yellow-500/10 rounded-xl text-yellow-400 border border-yellow-500/20">
                <Clock className="w-6 h-6" />
              </div>
            </div>
          </div>

          {empty ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-10 text-center space-y-2">
              <BarChart2 className="w-6 h-6 text-gray-600 mx-auto" />
              <p className="text-sm text-gray-300">{t("reports.emptyPeriod")}</p>
              <p className="text-xs text-gray-500">{periodLabel}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              <div className="xl:col-span-2 bg-gray-900 border border-gray-800 rounded-xl p-6">
                <h3 className="text-sm font-semibold text-gray-300 mb-5 flex items-center gap-2">
                  <BarChart2 className="w-4 h-4 text-blue-400" />
                  {period === "daily" ? t("reports.eventsByType") : t("reports.eventsOverTime")}
                </h3>
                <ResponsiveContainer width="100%" height={240}>
                  {period === "daily" ? (
                    <BarChart data={typeSeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                      <XAxis dataKey="name" stroke="#4b5563" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke="#4b5563" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Bar dataKey="value" name={t("reports.chartEvents")} fill="#2563eb" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  ) : (
                    <AreaChart data={dailySeries}>
                      <defs>
                        <linearGradient id="colorEvents" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#2563eb" stopOpacity={0.8} />
                          <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="colorAlerts" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#dc2626" stopOpacity={0.8} />
                          <stop offset="95%" stopColor="#dc2626" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                      <XAxis dataKey="label" stroke="#4b5563" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke="#4b5563" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Legend />
                      {/* Stable dataKeys so switching language never breaks the series. */}
                      <Area
                        type="monotone"
                        dataKey="count"
                        name={t("reports.chartEvents")}
                        stroke="#2563eb"
                        fillOpacity={1}
                        fill="url(#colorEvents)"
                      />
                      <Area
                        type="monotone"
                        dataKey="alerts"
                        name={t("reports.chartAlerts")}
                        stroke="#dc2626"
                        fillOpacity={1}
                        fill="url(#colorAlerts)"
                      />
                    </AreaChart>
                  )}
                </ResponsiveContainer>
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                <h3 className="text-sm font-semibold text-gray-300 mb-5 flex items-center gap-2">
                  <PieIcon className="w-4 h-4 text-purple-400" />
                  {t("reports.byEventType")}
                </h3>
                {typeSeries.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie
                        data={typeSeries}
                        cx="50%"
                        cy="50%"
                        outerRadius={75}
                        dataKey="value"
                        label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                        labelLine={false}
                        fontSize={10}
                      >
                        {typeSeries.map((_, index) => (
                          <Cell key={index} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-gray-500 text-sm text-center py-12">{t("reports.noData")}</p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
