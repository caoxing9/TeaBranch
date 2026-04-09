import { useState, useCallback } from "react";
import type { DevCategory } from "../lib/types";

const STORAGE_KEY = "teabranch-dev-categories";

function load(): Record<string, DevCategory> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function save(data: Record<string, DevCategory>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function useDevCategories() {
  const [categories, setCategories] = useState<Record<string, DevCategory>>(load);

  const setCategory = useCallback((branchName: string, category: DevCategory) => {
    setCategories((prev) => {
      const next = { ...prev, [branchName]: category };
      save(next);
      return next;
    });
  }, []);

  const getCategory = useCallback(
    (branchName: string): DevCategory => {
      return categories[branchName] || "todo";
    },
    [categories]
  );

  return { categories, getCategory, setCategory };
}
