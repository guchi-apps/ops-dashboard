export interface ChangelogEntry {
    version: string
    date: string
    changes: string[]
}

// 新しいバージョンを配列の先頭に追記していく（changelog-ja skill の運用ルールに従う）
export const changelog: ChangelogEntry[] = [
    {
        version: "0.1.2",
        date: "2026-07-27",
        changes: ["ダークモードに対応しました。"],
    },
]
