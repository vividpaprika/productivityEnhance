import { useState, useEffect } from "react";
import {
  Plus,
  Trash2,
  AlertTriangle,
  Settings as SettingsIcon,
  Clock,
  Calendar,
  Check,
  Play,
  Pause,
  Download,
  Pencil,
  Copy,
} from "lucide-react";

/* ============================================================================
 * タスク管理アプリ
 * ----------------------------------------------------------------------------
 * ファイルの構成(上から順に):
 *   1. 定数
 *   2. ユーティリティ関数 / オブジェクト
 *        - getCategoryColor … カテゴリの色を自動で決める
 *        - TimeUtils        … 日付・時刻の表示や計算
 *        - TaskCalc         … タスクの「経過時間」「残り時間」などの計算(読み取り専用)
 *        - TaskOps          … タスク配列を新規作成・更新する処理(immutableな更新)
 *        - TaskStorage      … 保存先(window.storage)への読み書き(失敗時は自動リトライ)
 *        - CsvExporter      … CSVファイルを組み立ててダウンロードする処理
 *   3. 画面の部品(UIコンポーネント) … 小さい部品を組み合わせて画面を作る
 *   4. メインコンポーネント (TaskManager) … 状態管理と、上記部品の組み立て
 *
 * 修正したいときの目安:
 *   ・「計算のルールを変えたい」(例: 警告を出すタイミング) → TaskCalc を直す
 *   ・「保存の挙動やタイミングを変えたい」                  → TaskStorage と、メインコンポーネント内の
 *                                                          handleAddTask / handleExportCsv / handleResetAll を直す
 *   ・「入力項目を増やしたい/見た目を変えたい」              → TaskFieldsForm を直す
 *   ・「1行の見た目を変えたい」                             → ActiveTaskRow / CompletedTaskRow を直す
 *   ・「データの持ち方自体を変えたい」(新しい項目を追加 等)   → TaskOps.build を直す
 *
 * 保存(window.storageへの書き込み)について:
 *   このアプリは「タスクの新規追加が完了したとき」と「CSVエクスポートを押したとき」の
 *   2つのタイミングだけで保存を行う。それ以外の操作(完了切替・開始/一時停止・編集・削除・
 *   設定変更)は画面表示(React の state)だけを更新し、保存はしない。
 *   ただし「全データリセット」だけは例外的に保存する(保存しないとリセットしても
 *   次回開いたときに元のデータへ戻ってしまい、リセット機能自体が意味をなさなくなるため)。
 * ============================================================================ */

// ----------------------------------------------------------------------------
// 1. 定数
// ----------------------------------------------------------------------------
const STORAGE_KEY = "taskmanager-data"; // 保存データのキー名
const SAVE_RETRY_COUNT = 2; // 保存に失敗したときに自動で再試行する回数
const DURATION_PRESETS = [15, 30, 60, 90, 120]; // 所要時間のワンタップ候補(分)
const CATEGORY_COLORS = [
  { bg: "bg-blue-100", text: "text-blue-700" },
  { bg: "bg-purple-100", text: "text-purple-700" },
  { bg: "bg-emerald-100", text: "text-emerald-700" },
  { bg: "bg-amber-100", text: "text-amber-700" },
  { bg: "bg-pink-100", text: "text-pink-700" },
  { bg: "bg-cyan-100", text: "text-cyan-700" },
  { bg: "bg-orange-100", text: "text-orange-700" },
  { bg: "bg-indigo-100", text: "text-indigo-700" },
];

// ----------------------------------------------------------------------------
// 2. ユーティリティ
// ----------------------------------------------------------------------------

/** カテゴリ名の文字列から、見た目の色を自動で決める(同じ名前なら毎回同じ色になる) */
function getCategoryColor(category) {
  let hash = 0;
  for (let i = 0; i < category.length; i++) hash = category.charCodeAt(i) + ((hash << 5) - hash);
  return CATEGORY_COLORS[Math.abs(hash) % CATEGORY_COLORS.length];
}

/** 日付・時刻まわりの表示/計算をまとめたオブジェクト */
const TimeUtils = {
  pad2(n) {
    return String(n).padStart(2, "0");
  },
  // 今日の日付を "YYYY-MM-DD" で返す
  todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${this.pad2(d.getMonth() + 1)}-${this.pad2(d.getDate())}`;
  },
  // 新規タスクの期限の初期値(今日の18:00)
  defaultDeadline() {
    return `${this.todayStr()}T18:00`;
  },
  // "YYYY-MM-DDTHH:MM" から日付部分だけを取り出す(日別グループ化に使う)
  dateKeyOf(deadline) {
    return deadline ? deadline.split("T")[0] : this.todayStr();
  },
  // "YYYY-MM-DDTHH:MM" から時刻部分だけを取り出す
  timeKeyOf(deadline) {
    if (!deadline || !deadline.includes("T")) return "";
    return deadline.split("T")[1] || "";
  },
  // 日付グループの見出し用ラベル("今日 6/21 (日)" など)を作る
  dateLabel(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((d - today) / 86400000);
    const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
    const base = `${d.getMonth() + 1}/${d.getDate()} (${weekdays[d.getDay()]})`;
    if (diffDays === 0) return { label: `今日 ${base}`, isPast: false, isToday: true };
    if (diffDays === 1) return { label: `明日 ${base}`, isPast: false, isToday: false };
    if (diffDays < 0) return { label: `${base} ・期限超過`, isPast: true, isToday: false };
    return { label: base, isPast: false, isToday: false };
  },
  // 分数を「○時間○分」の表記にする
  minutesLabel(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h === 0) return `${m}分`;
    if (m === 0) return `${h}時間`;
    return `${h}時間${m}分`;
  },
};

/** タスクの「経過時間(作業タイマー)」の計算をまとめたオブジェクト(データは変更しない)。
 *  「期限超過」の判定は、締切の日時ではなく「計測した経過時間が所要時間を超えたかどうか」で行う。 */
const TaskCalc = {
  // 作業タイマーの経過秒数(一時停止中はそのまま、計測中は現在時刻との差分を足す)
  elapsedSeconds(task, now) {
    const base = task.elapsedSeconds || 0;
    if (task.status === "running" && task.runStartedAt) {
      return base + (now - task.runStartedAt) / 1000;
    }
    return base;
  },
  // 経過時間(分)が所要時間(分)を超えているかどうかを判定する。「期限超過」表示・プログレスバーの色はこれを使う。
  isOverDuration(task, now) {
    const elapsedMin = Math.floor(this.elapsedSeconds(task, now) / 60);
    const plannedMin = task.duration || 0;
    return plannedMin > 0 && elapsedMin > plannedMin;
  },
};

/** タスク配列に対する「追加・更新・削除」などの操作をまとめたオブジェクト。
 *  すべて「元の配列は変更せず、新しい配列を返す」(immutableな)関数になっている。
 *  仕様変更(例: タスクに新しい項目を増やす)は基本的にこのオブジェクトの中だけで完結する。 */
const TaskOps = {
  // 入力内容(draft)から、新しいタスクオブジェクトを1件組み立てる
  build(draft) {
    return {
      id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: draft.name.trim(),
      category: draft.category.trim() || "未分類",
      deadline: draft.deadline || TimeUtils.defaultDeadline(),
      duration: Number(draft.duration) || 0,
      completed: false,
      status: "pending", // pending(未着手) / running(計測中) / paused(一時停止)
      elapsedSeconds: 0,
      runStartedAt: null,
    };
  },
  add(tasks, draft) {
    return [...tasks, this.build(draft)];
  },
  remove(tasks, id) {
    return tasks.filter((t) => t.id !== id);
  },
  // 既存タスクの内容(名前・カテゴリ・期限・所要時間)を編集内容で上書きする
  update(tasks, id, draft) {
    return tasks.map((t) =>
      t.id === id
        ? {
            ...t,
            name: draft.name.trim(),
            category: draft.category.trim() || "未分類",
            deadline: draft.deadline || TimeUtils.defaultDeadline(),
            duration: Number(draft.duration) || 0,
          }
        : t
    );
  },
  // タスクを複製する。複製後のタスクは未着手の状態からスタートする
  duplicate(tasks, id) {
    const original = tasks.find((t) => t.id === id);
    if (!original) return { tasks, newTask: null };
    const newTask = this.build({
      name: `${original.name} (コピー)`,
      category: original.category,
      deadline: original.deadline,
      duration: original.duration,
    });
    return { tasks: [...tasks, newTask], newTask };
  },
  // 完了/未完了を切り替える。完了にする瞬間にタイマーが動いていたら止めて経過時間を確定する
  toggleComplete(tasks, id) {
    return tasks.map((t) => {
      if (t.id !== id) return t;
      const completed = !t.completed;
      if (completed && t.status === "running" && t.runStartedAt) {
        const additional = (Date.now() - t.runStartedAt) / 1000;
        return { ...t, completed, status: "paused", elapsedSeconds: (t.elapsedSeconds || 0) + additional, runStartedAt: null };
      }
      return { ...t, completed };
    });
  },
  start(tasks, id) {
    return tasks.map((t) => (t.id === id && t.status !== "running" ? { ...t, status: "running", runStartedAt: Date.now() } : t));
  },
  pause(tasks, id) {
    return tasks.map((t) => {
      if (t.id !== id || t.status !== "running") return t;
      const additional = t.runStartedAt ? (Date.now() - t.runStartedAt) / 1000 : 0;
      return { ...t, status: "paused", elapsedSeconds: (t.elapsedSeconds || 0) + additional, runStartedAt: null };
    });
  },
  // 過去バージョン(期限が日付のみだった頃)のデータを読み込んだとき、日時形式に補正する
  normalizeLoaded(tasks) {
    return (tasks || []).map((t) => ({
      ...t,
      deadline: t.deadline && t.deadline.includes("T") ? t.deadline : `${t.deadline || TimeUtils.todayStr()}T18:00`,
    }));
  },
};

/** 保存先(window.storage)への読み書きをまとめたオブジェクト。
 *  保存リクエストが短時間に集中すると失敗することがあるため、save() は失敗時に
 *  間隔を空けながら自動で再試行する(呼び出し側は結果の { ok } だけ見ればよい)。
 *  ※ save() を呼び出す箇所は、メインコンポーネントの handleAddTask / handleExportCsv /
 *    handleResetAll の3か所に限定している(詳細はファイル冒頭のコメントを参照)。 */
const TaskStorage = {
  key: STORAGE_KEY,
  async load() {
    try {
      const res = await window.storage.get(this.key, false);
      if (!res || !res.value) return null;
      return JSON.parse(res.value);
    } catch (e) {
      return null; // データが無い場合もここに来る(初回利用時など)
    }
  },
  async save(tasks, maxDailyMinutes, attempt = 0) {
    try {
      const result = await window.storage.set(this.key, JSON.stringify({ tasks, maxDailyMinutes }), false);
      if (result) return { ok: true };
      if (attempt < SAVE_RETRY_COUNT) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        return this.save(tasks, maxDailyMinutes, attempt + 1);
      }
      return { ok: false };
    } catch (e) {
      if (attempt < SAVE_RETRY_COUNT) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        return this.save(tasks, maxDailyMinutes, attempt + 1);
      }
      return { ok: false };
    }
  },
};

/** CSV出力(組み立て+ダウンロード)をまとめたオブジェクト */
const CsvExporter = {
  escape(field) {
    const str = String(field ?? "");
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  },
  statusLabel(t) {
    return t.completed ? "完了" : t.status === "running" ? "実施中" : t.status === "paused" ? "一時停止" : "未着手";
  },
  build(tasks) {
    const headers = ["タスク名", "カテゴリ", "期限", "所要時間(分)", "経過時間(分)", "状態"];
    const rows = tasks.map((t) => {
      const elapsedMin = Math.round(TaskCalc.elapsedSeconds(t, Date.now()) / 60);
      return [t.name, t.category, (t.deadline || "").replace("T", " "), t.duration, elapsedMin, this.statusLabel(t)];
    });
    const bom = "\uFEFF"; // Excelで文字化けしないようにする
    return bom + [headers, ...rows].map((row) => row.map(this.escape).join(",")).join("\r\n");
  },
  download(tasks) {
    const blob = new Blob([this.build(tasks)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tasks_${TimeUtils.todayStr()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
};

// ----------------------------------------------------------------------------
// 3. 画面の部品(UIコンポーネント)
// ----------------------------------------------------------------------------

/** ヘッダー(タイトル + CSV出力ボタン + 設定ボタン) */
function AppHeader({ onExportCsv, onToggleSettings }) {
  return (
    <div className="flex items-center justify-between mb-5">
      <div className="flex items-center gap-2">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-500 flex items-center justify-center text-white font-bold">T</div>
        <h1 className="text-xl font-bold text-slate-900">タスク管理</h1>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={onExportCsv} title="CSVエクスポート(この操作のタイミングでも保存されます)" className="p-2 rounded-lg hover:bg-slate-200 text-slate-500 flex items-center gap-1">
          <Download size={20} />
        </button>
        <button onClick={onToggleSettings} className="p-2 rounded-lg hover:bg-slate-200 text-slate-500">
          <SettingsIcon size={20} />
        </button>
      </div>
    </div>
  );
}

/** 保存エラーが出ているときだけ表示する通知バー */
function SaveErrorBanner({ message, onRetry }) {
  if (!message) return null;
  return (
    <div className="mb-3 px-3 py-2 bg-red-50 text-red-600 text-sm rounded-lg flex items-center justify-between gap-3">
      <span>{message}</span>
      <button onClick={onRetry} className="text-xs font-semibold underline flex-shrink-0">
        再試行
      </button>
    </div>
  );
}

/** 設定パネル(1日の上限時間 / 全データリセット) */
function SettingsPanel({ maxDailyMinutes, onChangeMax, confirmReset, onRequestReset, onConfirmReset, onCancelReset }) {
  return (
    <div className="mb-5 p-4 bg-white rounded-xl shadow-sm border border-slate-200">
      <label className="block text-sm font-medium text-slate-600 mb-2">1日あたりの最大合計時間(分)</label>
      <div className="flex items-center gap-3">
        <input
          type="number"
          min="0"
          value={maxDailyMinutes}
          onChange={(e) => onChangeMax(e.target.value)}
          className="w-28 px-3 py-2 border border-slate-300 rounded-lg text-sm"
        />
        <span className="text-sm text-slate-400">= {TimeUtils.minutesLabel(maxDailyMinutes)}</span>
      </div>
      <p className="mt-2 text-xs text-slate-400">※ この変更はタスク追加またはCSVエクスポート時に保存されます</p>
      {!confirmReset ? (
        <button onClick={onRequestReset} className="mt-4 text-sm text-red-500 hover:text-red-600 flex items-center gap-1">
          <Trash2 size={14} /> すべてのデータをリセット
        </button>
      ) : (
        <div className="mt-4 flex items-center gap-2">
          <span className="text-sm text-red-500">本当に削除しますか?(この操作は即座に保存されます)</span>
          <button onClick={onConfirmReset} className="text-xs px-2.5 py-1 bg-red-500 text-white rounded-md">
            はい
          </button>
          <button onClick={onCancelReset} className="text-xs px-2.5 py-1 bg-slate-200 rounded-md">
            キャンセル
          </button>
        </div>
      )}
    </div>
  );
}

/** タスク名・カテゴリ・期限・所要時間の入力欄。新規追加フォームと編集フォームの両方で共用する。
 *  「入力項目を増やしたい」「見た目を変えたい」場合はここを直せば両方に反映される。
 *    draft      : { name, category, deadline, duration } 入力中の値
 *    onChange   : (フィールド名, 新しい値) => void
 *    categories : カテゴリ入力のオートコンプリート候補
 *    onEnterKey : タスク名欄でEnterキーを押したときに呼ばれる(任意) */
function TaskFieldsForm({ draft, onChange, categories, onEnterKey }) {
  return (
    <>
      <input
        type="text"
        value={draft.name}
        onChange={(e) => onChange("name", e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnterKey) onEnterKey();
        }}
        placeholder="タスク名を入力..."
        className="w-full px-3 py-2.5 mb-3 border border-slate-300 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-400"
      />
      <div className="grid grid-cols-2 gap-2 mb-3">
        <input
          list="category-list"
          type="text"
          value={draft.category}
          onChange={(e) => onChange("category", e.target.value)}
          placeholder="カテゴリ"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
        />
        <input
          type="datetime-local"
          value={draft.deadline}
          onChange={(e) => onChange("deadline", e.target.value)}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Clock size={16} className="text-slate-400" />
        {DURATION_PRESETS.map((p) => (
          <button
            type="button"
            key={p}
            onClick={() => onChange("duration", p)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border ${
              Number(draft.duration) === p
                ? "bg-indigo-500 text-white border-indigo-500"
                : "bg-white text-slate-500 border-slate-300 hover:bg-slate-100"
            }`}
          >
            {p}分
          </button>
        ))}
        <input
          type="number"
          min="0"
          value={draft.duration}
          onChange={(e) => onChange("duration", e.target.value)}
          className="w-20 px-2 py-1 border border-slate-300 rounded-lg text-xs"
        />
      </div>
    </>
  );
}

/** 新規タスク追加カード(入力欄は TaskFieldsForm を共用し、ここでは「追加」ボタンだけ持つ)。
 *  「追加」を押す(=onAdd が呼ばれる)タイミングで実際の保存も行われる。 */
function AddTaskCard({ draft, onChange, onAdd, categories }) {
  return (
    <div className="mb-6 p-4 bg-white rounded-xl shadow-sm border border-slate-200">
      <div className="mb-3">
        <TaskFieldsForm draft={draft} onChange={onChange} categories={categories} onEnterKey={onAdd} />
      </div>
      <button
        onClick={onAdd}
        className="w-full py-2.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 transition-colors"
      >
        <Plus size={16} /> 追加
      </button>
    </div>
  );
}

/** 既存タスクの編集フォーム(入力欄は TaskFieldsForm を共用し、保存/キャンセルだけここで持つ)。
 *  ここでの「保存」は画面表示(state)の更新のみで、ストレージへの書き込みは行わない
 *  (次にタスクを追加するかCSVエクスポートするまでは保存されない点に注意)。 */
function EditTaskRow({ task, draft, onChange, onSave, onCancel, categories }) {
  return (
    <div className="px-4 py-3 bg-indigo-50/60 border-l-2 border-indigo-400">
      <div className="mb-3">
        <TaskFieldsForm draft={draft} onChange={onChange} categories={categories} onEnterKey={() => onSave(task.id)} />
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSave(task.id)}
          className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-xs font-semibold flex items-center gap-1"
        >
          <Check size={13} /> 保存
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-600 rounded-lg text-xs font-semibold">
          キャンセル
        </button>
      </div>
    </div>
  );
}

/** 未完了タスクの1行。チェック・名前・タグ類、締切までの残り時間バー、開始/一時停止ボタンと作業時間バー、
 *  編集/複製/削除アイコンをまとめて表示する。 */
function ActiveTaskRow({ task, now, onToggleComplete, onStart, onPause, onEdit, onDuplicate, onDelete }) {
  const c = getCategoryColor(task.category);
  const elapsedSec = TaskCalc.elapsedSeconds(task, now);
  const elapsedMin = Math.floor(elapsedSec / 60);
  const plannedMin = task.duration || 0;
  const workPct = plannedMin > 0 ? Math.min(100, (elapsedMin / plannedMin) * 100) : task.status === "running" ? 100 : 0;
  const workOver = TaskCalc.isOverDuration(task, now); // 「期限超過」は所要時間を超えたかどうかで判定する
  const isRunning = task.status === "running";
  const isPaused = task.status === "paused";
  const timeLabel = TimeUtils.timeKeyOf(task.deadline);

  return (
    <div className="px-4 py-3 group">
      {/* 上段: チェック・タスク名・タグ・操作アイコン */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => onToggleComplete(task.id)}
          className="w-5 h-5 rounded-full border-2 border-slate-300 hover:border-indigo-400 flex-shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-700 truncate">{task.name}</div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded-full ${c.bg} ${c.text}`}>{task.category}</span>
            <span className="text-xs text-slate-400">{TimeUtils.minutesLabel(task.duration)}</span>
            {timeLabel && <span className="text-xs text-slate-400">〆{timeLabel}</span>}
          </div>
        </div>

        <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={() => onEdit(task)} className="p-1.5 text-slate-300 hover:text-indigo-500">
            <Pencil size={15} />
          </button>
          <button onClick={() => onDuplicate(task.id)} className="p-1.5 text-slate-300 hover:text-indigo-500">
            <Copy size={15} />
          </button>
          <button onClick={() => onDelete(task.id)} className="p-1.5 text-slate-300 hover:text-red-500">
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {/* 下段: 開始/一時停止ボタンと、所要時間に対する進捗バー(所要時間を超えたら「期限超過」と赤で表示) */}
      <div className="mt-2 ml-8 flex items-center gap-2 flex-wrap">
        <button
          onClick={() => onStart(task.id)}
          className={`px-2.5 py-1 rounded-md text-xs font-semibold border flex items-center gap-1 transition-all duration-150 ${
            isRunning
              ? "bg-emerald-500 border-emerald-600 text-white shadow-inner translate-y-px"
              : "bg-white border-slate-300 text-slate-500 shadow-sm hover:bg-slate-50"
          }`}
        >
          <Play size={12} /> 開始
        </button>
        <button
          onClick={() => onPause(task.id)}
          className={`px-2.5 py-1 rounded-md text-xs font-semibold border flex items-center gap-1 transition-all duration-150 ${
            isPaused
              ? "bg-amber-500 border-amber-600 text-white shadow-inner translate-y-px"
              : "bg-white border-slate-300 text-slate-500 shadow-sm hover:bg-slate-50"
          }`}
        >
          <Pause size={12} /> 一時停止
        </button>
        <div className="flex-1 min-w-[100px]">
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${workOver ? "bg-red-500" : isRunning ? "bg-emerald-400" : "bg-amber-300"}`}
              style={{ width: `${workPct}%` }}
            />
          </div>
          <div className={`text-[10px] mt-0.5 ${workOver ? "text-red-500 font-medium" : "text-slate-400"}`}>
            経過 {elapsedMin}分{plannedMin > 0 ? ` / ${plannedMin}分予定` : ""}
            {workOver ? " ・期限超過" : ""}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 完了済みタスクの1行(シンプルな表示。タイマーや締切バーは出さない) */
function CompletedTaskRow({ task, onToggleComplete, onEdit, onDuplicate, onDelete }) {
  const c = getCategoryColor(task.category);
  const finalMin = Math.floor((task.elapsedSeconds || 0) / 60);
  return (
    <div className="px-4 py-3 flex items-center gap-3 group bg-slate-50/50">
      <button
        onClick={() => onToggleComplete(task.id)}
        className="w-5 h-5 rounded-full border-2 border-emerald-400 bg-emerald-400 flex items-center justify-center flex-shrink-0"
      >
        <Check size={12} className="text-white" />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-400 line-through truncate">{task.name}</div>
        <div className="flex items-center gap-2 mt-1">
          <span className={`text-xs px-2 py-0.5 rounded-full ${c.bg} ${c.text} opacity-50`}>{task.category}</span>
          <span className="text-xs text-slate-300">
            {TimeUtils.minutesLabel(task.duration)}
            {finalMin > 0 ? ` ・実績${finalMin}分` : ""}
          </span>
        </div>
      </div>
      <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={() => onEdit(task)} className="p-1.5 text-slate-300 hover:text-indigo-500">
          <Pencil size={15} />
        </button>
        <button onClick={() => onDuplicate(task.id)} className="p-1.5 text-slate-300 hover:text-indigo-500">
          <Copy size={15} />
        </button>
        <button onClick={() => onDelete(task.id)} className="p-1.5 text-slate-300 hover:text-red-500">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}

/** 「ある締切日」のタスクをまとめて表示するカード。
 *  上部にその日の合計所要時間と、1日の上限(maxDailyMinutes)超過の警告を表示する。
 *  handlers にはタスク操作の各関数(完了切替・開始・削除など)をまとめて渡す。 */
function DayGroupCard({ dateKey, tasks, maxDailyMinutes, now, editingId, editDraft, onEditDraftChange, categories, handlers }) {
  const activeTasks = tasks.filter((t) => !t.completed);
  const completedTasks = tasks.filter((t) => t.completed);
  const totalMin = activeTasks.reduce((s, t) => s + t.duration, 0);
  const over = maxDailyMinutes > 0 && totalMin > maxDailyMinutes;
  const { label, isPast, isToday } = TimeUtils.dateLabel(dateKey);
  const pct = maxDailyMinutes > 0 ? Math.min(100, (totalMin / maxDailyMinutes) * 100) : 0;

  return (
    <div
      className={`bg-white rounded-xl shadow-sm border overflow-hidden ${
        isToday ? "border-indigo-300 ring-1 ring-indigo-200" : "border-slate-200"
      }`}
    >
      <div className={`px-4 py-3 flex items-center justify-between ${over ? "bg-red-50" : "bg-slate-50"}`}>
        <div className="flex items-center gap-2">
          <Calendar size={15} className={isPast ? "text-red-400" : "text-slate-400"} />
          <span className={`text-sm font-semibold ${isPast ? "text-red-500" : "text-slate-700"}`}>{label}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {over && <AlertTriangle size={15} className="text-red-500" />}
          <span className={`text-xs font-medium ${over ? "text-red-500" : "text-slate-400"}`}>
            {TimeUtils.minutesLabel(totalMin)} / {TimeUtils.minutesLabel(maxDailyMinutes)}
          </span>
        </div>
      </div>
      <div className="h-1 bg-slate-100">
        <div className={`h-full transition-all ${over ? "bg-red-500" : "bg-indigo-400"}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="divide-y divide-slate-100">
        {activeTasks.map((t) =>
          editingId === t.id ? (
            <EditTaskRow
              key={t.id}
              task={t}
              draft={editDraft}
              onChange={onEditDraftChange}
              onSave={handlers.onSaveEdit}
              onCancel={handlers.onCancelEdit}
              categories={categories}
            />
          ) : (
            <ActiveTaskRow
              key={t.id}
              task={t}
              now={now}
              onToggleComplete={handlers.onToggleComplete}
              onStart={handlers.onStart}
              onPause={handlers.onPause}
              onEdit={handlers.onStartEdit}
              onDuplicate={handlers.onDuplicate}
              onDelete={handlers.onDelete}
            />
          )
        )}
        {completedTasks.map((t) =>
          editingId === t.id ? (
            <EditTaskRow
              key={t.id}
              task={t}
              draft={editDraft}
              onChange={onEditDraftChange}
              onSave={handlers.onSaveEdit}
              onCancel={handlers.onCancelEdit}
              categories={categories}
            />
          ) : (
            <CompletedTaskRow
              key={t.id}
              task={t}
              onToggleComplete={handlers.onToggleComplete}
              onEdit={handlers.onStartEdit}
              onDuplicate={handlers.onDuplicate}
              onDelete={handlers.onDelete}
            />
          )
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// 4. メインコンポーネント
// ----------------------------------------------------------------------------
export default function TaskManager() {
  // ---- 画面の状態 ----
  const [tasks, setTasks] = useState([]);
  const [maxDailyMinutes, setMaxDailyMinutes] = useState(480);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [now, setNow] = useState(Date.now()); // 表示用の「現在時刻」。定期的に更新してカウントダウン等を進める

  const [newTaskDraft, setNewTaskDraft] = useState({ name: "", category: "", deadline: TimeUtils.defaultDeadline(), duration: 30 });
  const [editingId, setEditingId] = useState(null); // 編集中タスクのID(nullなら編集なし)
  const [editDraft, setEditDraft] = useState({ name: "", category: "", deadline: "", duration: 0 });

  // ---- 起動時にデータを読み込む(保存は行わない。読み込みのみ) ----
  useEffect(() => {
    (async () => {
      const data = await TaskStorage.load();
      if (data) {
        const loadedTasks = TaskOps.normalizeLoaded(data.tasks);
        setTasks(loadedTasks);
        setMaxDailyMinutes(data.maxDailyMinutes ?? 480);
        if (loadedTasks.length > 0) {
          const lastCategory = loadedTasks[loadedTasks.length - 1].category;
          if (lastCategory) setNewTaskDraft((d) => ({ ...d, category: lastCategory }));
        }
      }
      setLoading(false);
    })();
  }, []);

  // ---- 現在時刻を定期更新(未完了タスクがある間だけ。30秒ごとで十分な精度) ----
  const hasActiveTasks = tasks.some((t) => !t.completed);
  useEffect(() => {
    if (!hasActiveTasks) return;
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, [hasActiveTasks]);

  // 保存処理を呼び出して、結果に応じてエラー表示を更新する共通ヘルパー
  async function persistNow(tasksToSave, maxToSave) {
    const result = await TaskStorage.save(tasksToSave, maxToSave);
    setSaveError(result.ok ? "" : "保存に失敗しました。しばらく待ってから「再試行」を押してください。");
    return result;
  }

  // ---- 入力フォームの値変更(画面表示のみ。保存はしない) ----
  function updateNewTaskDraft(field, value) {
    setNewTaskDraft((d) => ({ ...d, [field]: value }));
  }
  function updateEditDraft(field, value) {
    setEditDraft((d) => ({ ...d, [field]: value }));
  }

  // ==== ここから「保存を伴わない」操作 ===========================
  // 画面表示(state)だけを更新する。ストレージへは書き込まない。
  function handleToggleComplete(id) {
    setTasks((prev) => TaskOps.toggleComplete(prev, id));
  }
  function handleStart(id) {
    setTasks((prev) => TaskOps.start(prev, id));
  }
  function handlePause(id) {
    setTasks((prev) => TaskOps.pause(prev, id));
  }
  function handleDelete(id) {
    setTasks((prev) => TaskOps.remove(prev, id));
    if (editingId === id) setEditingId(null);
  }
  function handleChangeMax(val) {
    setMaxDailyMinutes(Number(val) || 0);
  }
  function handleStartEdit(task) {
    setEditingId(task.id);
    setEditDraft({ name: task.name, category: task.category, deadline: task.deadline, duration: task.duration });
  }
  function handleCancelEdit() {
    setEditingId(null);
  }
  function handleSaveEdit(id) {
    if (!editDraft.name.trim()) return;
    setTasks((prev) => TaskOps.update(prev, id, editDraft));
    setEditingId(null);
  }
  function handleDuplicate(id) {
    const { tasks: nextTasks, newTask } = TaskOps.duplicate(tasks, id);
    if (!newTask) return;
    setTasks(nextTasks);
    setEditingId(newTask.id);
    setEditDraft({ name: newTask.name, category: newTask.category, deadline: newTask.deadline, duration: newTask.duration });
  }
  // ==== ここまで「保存を伴わない」操作 ===========================

  // ==== ここから「保存を伴う」操作(全部で3か所だけ) =================
  // タスク追加が完了した瞬間に保存する
  async function handleAddTask() {
    if (!newTaskDraft.name.trim()) return;
    const nextTasks = TaskOps.add(tasks, newTaskDraft);
    setTasks(nextTasks);
    setNewTaskDraft((d) => ({ ...d, name: "" })); // 名前だけ空にし、カテゴリ・期限・所要時間は次の入力のため残す
    await persistNow(nextTasks, maxDailyMinutes);
  }

  // CSVエクスポートを押した瞬間に保存する(エクスポート自体は現在の画面内容で行う)
  async function handleExportCsv() {
    CsvExporter.download(tasks);
    await persistNow(tasks, maxDailyMinutes);
  }

  // リセットは例外的に保存する(保存しないとリセットしても元のデータへ戻ってしまうため)
  async function handleResetAll() {
    setTasks([]);
    setMaxDailyMinutes(480);
    setConfirmReset(false);
    setEditingId(null);
    await persistNow([], 480);
  }
  // ==== ここまで「保存を伴う」操作 =================================

  // 保存エラー時の「再試行」ボタン用(現在の画面内容で保存し直す)
  function handleRetrySave() {
    persistNow(tasks, maxDailyMinutes);
  }

  // タスク操作系のハンドラをまとめておく(DayGroupCard へ渡すときに見通しを良くするため)
  const taskHandlers = {
    onToggleComplete: handleToggleComplete,
    onStart: handleStart,
    onPause: handlePause,
    onDelete: handleDelete,
    onStartEdit: handleStartEdit,
    onCancelEdit: handleCancelEdit,
    onSaveEdit: handleSaveEdit,
    onDuplicate: handleDuplicate,
  };

  // ---- 表示用データの整形 ----
  const categories = [...new Set(tasks.map((t) => t.category))];

  // 締切日ごとにタスクをグループ化する
  const groups = {};
  for (const t of tasks) {
    const key = TimeUtils.dateKeyOf(t.deadline);
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }
  const sortedDates = Object.keys(groups).sort();
  for (const key of sortedDates) {
    groups[key].sort((a, b) => (a.deadline || "").localeCompare(b.deadline || "")); // 同じ日の中は締切時刻が早い順
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-slate-400 text-sm">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <AppHeader onExportCsv={handleExportCsv} onToggleSettings={() => setShowSettings((s) => !s)} />

        <SaveErrorBanner message={saveError} onRetry={handleRetrySave} />

        {showSettings && (
          <SettingsPanel
            maxDailyMinutes={maxDailyMinutes}
            onChangeMax={handleChangeMax}
            confirmReset={confirmReset}
            onRequestReset={() => setConfirmReset(true)}
            onConfirmReset={handleResetAll}
            onCancelReset={() => setConfirmReset(false)}
          />
        )}

        <AddTaskCard draft={newTaskDraft} onChange={updateNewTaskDraft} onAdd={handleAddTask} categories={categories} />
        {/* カテゴリ入力のオートコンプリート候補(追加フォーム・編集フォーム共通) */}
        <datalist id="category-list">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>

        {sortedDates.length === 0 ? (
          <div className="text-center py-12 text-slate-400 text-sm">タスクはまだありません</div>
        ) : (
          <div className="space-y-5">
            {sortedDates.map((date) => (
              <DayGroupCard
                key={date}
                dateKey={date}
                tasks={groups[date]}
                maxDailyMinutes={maxDailyMinutes}
                now={now}
                editingId={editingId}
                editDraft={editDraft}
                onEditDraftChange={updateEditDraft}
                categories={categories}
                handlers={taskHandlers}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
