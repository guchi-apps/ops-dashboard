export interface ChangelogEntry {
    version: string
    date: string
    changes: string[]
}

// 新しいバージョンを配列の先頭に追記していく（changelog-ja skill の運用ルールに従う）
export const changelog: ChangelogEntry[] = [
    {
        version: "0.2.0",
        date: "2026-07-28",
        changes: [
            "ダークモードに対応しました。",
            "スマホのホーム画面に追加できるようになりました。",
            "フッターにバージョン番号を表示し、更新履歴を確認できるようにしました。",
        ],
    },
]
