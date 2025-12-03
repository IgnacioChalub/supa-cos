"use client";

import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { CodeBlock } from "./code-block";

type TabularRow = Record<string, unknown>;

type SupabaseSqlResultProps = {
  sql?: string;
  rows?: unknown;
};

const isTabularRow = (value: unknown): value is TabularRow => {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
};

const extractTabularRows = (rows: unknown): TabularRow[] | null => {
  if (!Array.isArray(rows)) {
    return null;
  }

  const tabularRows = rows.filter(isTabularRow);
  if (tabularRows.length === 0) {
    return [];
  }

  return tabularRows;
};

const formatCellValue = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
};

export const SupabaseSqlResult = ({ sql, rows }: SupabaseSqlResultProps) => {
  const [isSqlVisible, setIsSqlVisible] = useState(false);
  const tabularRows = extractTabularRows(rows);
  let columns: string[] = [];

  if (tabularRows && tabularRows.length > 0) {
    const allColumns = Array.from(
      tabularRows.reduce((set, row) => {
        Object.keys(row).forEach((key) => {
          if (!set.has(key)) {
            set.add(key);
          }
        });
        return set;
      }, new Set<string>())
    );
    columns = allColumns;
  }

  return (
    <div className="space-y-4">
      {sql ? (
        <div className="rounded-md border border-border/60">
          <button
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground"
            onClick={() => setIsSqlVisible((prev) => !prev)}
            type="button"
          >
            Consulta SQL
            <ChevronDownIcon
              className={`size-4 transition-transform ${
                isSqlVisible ? "rotate-180" : ""
              }`}
            />
          </button>
          {isSqlVisible ? (
            <div className="border-t border-border/60">
              <CodeBlock code={sql.trim()} language="sql" />
            </div>
          ) : null}
        </div>
      ) : null}
      {tabularRows ? (
        tabularRows.length > 0 ? (
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {tabularRows.length} {tabularRows.length === 1 ? "row" : "rows"}
            </p>
            <div className="w-full max-w-full overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    {columns.map((column) => (
                      <th key={column} className="px-3 py-2 font-medium capitalize">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tabularRows.map((row, rowIndex) => (
                    <tr
                      key={`row-${rowIndex}`}
                      className="border-b border-border/30 last:border-0"
                    >
                      {columns.map((column) => (
                        <td
                          key={`${rowIndex}-${column}`}
                          className="px-3 py-2 align-top font-mono text-[11px]"
                        >
                          {formatCellValue(row[column])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            No rows returned.
          </div>
        )
      ) : rows !== undefined ? (
        <CodeBlock
          code={
            typeof rows === "string" ? rows : JSON.stringify(rows, null, 2)
          }
          language="json"
        />
      ) : null}
    </div>
  );
};
