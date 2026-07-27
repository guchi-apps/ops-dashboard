import Link from "next/link"

import packageJson from "../../package.json"

export function AppFooter() {
    return (
        <footer className="mt-auto border-t border-slate-200 dark:border-slate-800 py-4 px-4 md:px-8">
            <div className="max-w-4xl mx-auto flex justify-end">
                <Link
                    href="/changelog"
                    className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
                >
                    v{packageJson.version}
                </Link>
            </div>
        </footer>
    )
}
