"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDate } from "@/lib/format";
import { StayStatusBadge } from "@/components/ui/Badge";
import { assignRoomFromRack } from "@/modules/rack/actions/assignments";
import type { RackCell, RackRoom } from "@/modules/rack/queries/grid";

const STATUS_STYLES: Record<string, string> = {
  IN_HOUSE: "bg-brand-soft border-brand text-foreground",
  OUT_OF_SERVICE: "bg-border-strong border-border-strong text-muted-strong",
  BLOCKED: "bg-warning-soft border-amber-300 text-amber-900",
  AVAILABLE: "bg-surface border-border text-muted",
};

interface DragPayload {
  stayId: string;
  roomTypeId: string;
  fromRoomId: string;
  fromRoomCode: string;
  guestName: string;
}

interface PendingMove extends DragPayload {
  toRoomId: string;
  toRoomCode: string;
}

export function RackGrid({ hotelId, dateRange, rooms, todayIso }: { hotelId: string; dateRange: string[]; rooms: RackRoom[]; todayIso: string }) {
  const router = useRouter();
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [dragOverRoomId, setDragOverRoomId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [moveReason, setMoveReason] = useState("");
  const [moveError, setMoveError] = useState<string | null>(null);
  const [isMoving, startMoving] = useTransition();
  const [openCell, setOpenCell] = useState<{ room: RackRoom; cell: RackCell } | null>(null);

  const roomsById = useMemo(() => new Map(rooms.map((r) => [r.roomId, r])), [rooms]);

  function handleDragStart(room: RackRoom, cell: RackCell) {
    if (!cell.stayId) return;
    setDragging({
      stayId: cell.stayId,
      roomTypeId: room.roomTypeId,
      fromRoomId: room.roomId,
      fromRoomCode: room.code,
      guestName: cell.guestName ?? "—",
    });
  }

  function handleDropOnRoom(targetRoom: RackRoom) {
    setDragOverRoomId(null);
    if (!dragging) return;
    if (dragging.fromRoomId === targetRoom.roomId) {
      setDragging(null);
      return;
    }
    setMoveError(null);
    setMoveReason("");
    setPendingMove({ ...dragging, toRoomId: targetRoom.roomId, toRoomCode: targetRoom.code });
    setDragging(null);
  }

  function confirmMove() {
    if (!pendingMove) return;
    startMoving(async () => {
      try {
        await assignRoomFromRack(hotelId, pendingMove.stayId, pendingMove.toRoomId, moveReason || undefined);
        setPendingMove(null);
        setMoveReason("");
        router.refresh();
      } catch (err) {
        setMoveError(err instanceof Error ? err.message : "No se pudo mover la estancia.");
      }
    });
  }

  const targetRoom = pendingMove ? roomsById.get(pendingMove.toRoomId) : null;
  const targetRoomTypeMismatch = pendingMove && targetRoom && targetRoom.roomTypeId !== pendingMove.roomTypeId;

  return (
    <div className="space-y-3">
      <div className="overflow-auto rounded-xl border border-border" style={{ maxHeight: "70vh" }}>
        <table className="min-w-full border-collapse text-xs">
          <thead className="sticky top-0 z-20 bg-surface">
            <tr>
              <th className="sticky left-0 z-30 min-w-[180px] border-b border-r border-border bg-surface px-3 py-2 text-left font-semibold">
                Habitación
              </th>
              {dateRange.map((date) => (
                <th
                  key={date}
                  className={`min-w-[92px] border-b border-border px-2 py-2 text-center font-medium ${
                    date === todayIso ? "bg-brand-soft" : ""
                  }`}
                >
                  {formatDate(date)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rooms.map((room) => (
              <tr
                key={room.roomId}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverRoomId(room.roomId);
                }}
                onDragLeave={() => setDragOverRoomId((id) => (id === room.roomId ? null : id))}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDropOnRoom(room);
                }}
                className={dragOverRoomId === room.roomId ? "bg-brand-soft/40" : ""}
              >
                <td className="sticky left-0 z-10 min-w-[180px] border-b border-r border-border bg-surface px-3 py-2 align-top">
                  <div className="font-semibold">{room.code}</div>
                  <div className="text-muted">{room.roomTypeName}</div>
                  <div className="mt-1 flex gap-1">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${room.isClean ? "bg-success-soft text-emerald-800" : "bg-warning-soft text-amber-900"}`}>
                      {room.isClean ? "Limpia" : "Sucia"}
                    </span>
                  </div>
                </td>
                {room.cells.map((cell) => (
                  <td
                    key={cell.date}
                    draggable={Boolean(cell.stayId)}
                    onDragStart={() => handleDragStart(room, cell)}
                    onClick={() => cell.stayId && setOpenCell({ room, cell })}
                    className={`min-w-[92px] border-b border-border px-1.5 py-2 align-top ${cell.stayId ? "cursor-pointer" : ""} ${
                      cell.date === todayIso ? "bg-brand-soft/20" : ""
                    }`}
                  >
                    <div
                      className={`rounded border px-1.5 py-1 text-[11px] leading-tight ${STATUS_STYLES[cell.status]} ${
                        cell.isConflict ? "ring-2 ring-danger" : ""
                      }`}
                      title={cell.conflictReason ?? undefined}
                    >
                      {cell.isConflict && <div className="font-bold text-danger">⚠ Conflicto</div>}
                      {cell.status === "IN_HOUSE" && <div className="truncate font-medium">{cell.guestName}</div>}
                      {cell.status === "OUT_OF_SERVICE" && <div>Fuera de servicio</div>}
                      {cell.status === "BLOCKED" && <div>Bloqueada</div>}
                      {cell.status === "AVAILABLE" && !cell.isArrival && !cell.isDeparture && <div className="text-muted">Libre</div>}
                      <div className="flex gap-1">
                        {cell.isArrival && <span title="Llegada">↘ Llega</span>}
                        {cell.isDeparture && <span title="Salida">↗ Sale</span>}
                      </div>
                    </div>
                  </td>
                ))}
              </tr>
            ))}
            {rooms.length === 0 && (
              <tr>
                <td colSpan={dateRange.length + 1} className="px-3 py-6 text-center text-muted">
                  Ninguna habitación coincide con el filtro actual.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pendingMove && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm space-y-3 rounded-xl bg-surface p-5 shadow-lg">
            <p className="font-semibold">
              Mover a {pendingMove.guestName} de {pendingMove.fromRoomCode} a {pendingMove.toRoomCode}
            </p>
            {targetRoomTypeMismatch && (
              <p className="rounded-lg border border-amber-200 bg-warning-soft px-3 py-2 text-amber-900">
                Esta habitación es de otro tipo. El servidor rechazará el movimiento (sólo se permite mover a una
                habitación equivalente).
              </p>
            )}
            {moveError && <p className="rounded-lg border border-red-200 bg-danger-soft px-3 py-2 text-red-800">{moveError}</p>}
            <label className="block text-xs font-medium text-muted-strong">
              Motivo (opcional)
              <input
                className="mt-1 w-full rounded-lg border border-border-strong px-3 py-2 text-sm"
                value={moveReason}
                onChange={(e) => setMoveReason(e.target.value)}
                placeholder="Ej. solicitud del huésped, mantenimiento…"
              />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                className="rounded-lg px-3 py-2 text-sm text-muted underline"
                onClick={() => {
                  setPendingMove(null);
                  setMoveError(null);
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={isMoving}
                onClick={confirmMove}
                className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
              >
                {isMoving ? "Moviendo…" : "Confirmar movimiento"}
              </button>
            </div>
          </div>
        </div>
      )}

      {openCell && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpenCell(null)}>
          <div className="w-full max-w-sm space-y-2 rounded-xl bg-surface p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="text-lg font-semibold">{openCell.cell.guestName}</p>
              {openCell.cell.stayStatus && <StayStatusBadge status={openCell.cell.stayStatus} />}
            </div>
            <p className="text-muted">Folio {openCell.cell.folio}</p>
            <p className="text-muted">
              Habitación {openCell.room.code} · {openCell.room.roomTypeName}
            </p>
            {(() => {
              const span = openCell.room.cells.filter((c) => c.reservationStayId === openCell.cell.reservationStayId);
              const firstNight = span[0]?.date;
              const lastNight = span[span.length - 1]?.date;
              return (
                <p className="text-muted">
                  Noches visibles en esta ventana: {formatDate(firstNight)} → {formatDate(lastNight)}
                </p>
              );
            })()}
            <div className="flex flex-wrap gap-3 pt-2">
              <Link href={`/recepcion?stayId=${openCell.cell.stayId}`} className="text-brand underline">
                Expediente
              </Link>
              <Link href={`/recepcion?stayId=${openCell.cell.stayId}`} className="text-brand underline">
                Check-In
              </Link>
              <Link href={`/recepcion?stayId=${openCell.cell.stayId}`} className="text-brand underline">
                Cobrar
              </Link>
            </div>
            <button type="button" className="pt-2 text-xs text-muted underline" onClick={() => setOpenCell(null)}>
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
