// HiddenView — soft-archive landing. Items and notes hidden via the ◐ menu
// collect here. Each row can be unhidden (↺) or deleted. Time-limited hides
// auto-leave this view when the day-boundary sweep clears their expiry, so
// nothing here needs a timer.

import { useCallback, useEffect, useState } from "react";
import { api, type Item } from "../lib";
import { notesApi, type Note } from "../notesApi";

const hideExpiryLabel = (until: string | null): string => {
  if (!until) return "forever";
  // until is ISO YYYY-MM-DD; show a friendly relative-ish label.
  return `until ${until}`;
};

export default function HiddenView() {
  const [items, setItems] = useState<Item[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);

  const refresh = useCallback(async () => {
    const [hiddenItems, hiddenNotes] = await Promise.all([
      api.listHiddenItems(),
      notesApi.listHidden(),
    ]);
    setItems(hiddenItems);
    setNotes(hiddenNotes);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleUnhideItem = async (id: string) => {
    setItems((s) => s.filter((i) => i.id !== id));
    await api.unhideItem(id);
  };
  const handleDeleteItem = async (id: string) => {
    setItems((s) => s.filter((i) => i.id !== id));
    await api.deleteItem(id);
  };
  const handleUnhideNote = async (id: string) => {
    setNotes((s) => s.filter((n) => n.id !== id));
    await notesApi.unhide(id);
  };
  const handleDeleteNote = async (id: string) => {
    setNotes((s) => s.filter((n) => n.id !== id));
    await notesApi.delete(id);
  };

  const empty = items.length === 0 && notes.length === 0;

  return (
    <div className="hidden-view">
      {empty && <div className="empty">Nothing hidden.</div>}

      {items.length > 0 && (
        <>
          <div className="section-head">
            <span className="section-name">Tasks</span>
          </div>
          {items.map((item) => (
            <div key={item.id} className="hidden-row">
              <span className={`hidden-badge ${item.hiddenUntil ? "dated" : ""}`}>
                {hideExpiryLabel(item.hiddenUntil)}
              </span>
              <span className="hidden-text">{item.text}</span>
              <button
                className="item-action unhide-btn"
                onClick={() => handleUnhideItem(item.id)}
                title="Unhide"
                aria-label="Unhide"
              >↺</button>
              <button
                className="item-action danger"
                onClick={() => handleDeleteItem(item.id)}
                title="Delete"
                aria-label="Delete"
              >×</button>
            </div>
          ))}
        </>
      )}

      {notes.length > 0 && (
        <>
          <div className="section-head">
            <span className="section-name">Notes</span>
          </div>
          {notes.map((note) => (
            <div key={note.id} className="hidden-row">
              <span className={`hidden-badge ${note.hiddenUntil ? "dated" : ""}`}>
                {hideExpiryLabel(note.hiddenUntil)}
              </span>
              <span className="hidden-text note-preview">
                {note.body.trim() || "Empty note"}
              </span>
              <button
                className="item-action unhide-btn"
                onClick={() => handleUnhideNote(note.id)}
                title="Unhide"
                aria-label="Unhide"
              >↺</button>
              <button
                className="item-action danger"
                onClick={() => handleDeleteNote(note.id)}
                title="Delete"
                aria-label="Delete"
              >×</button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
