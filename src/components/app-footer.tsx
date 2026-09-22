import Link from "next/link"

import packageJson from "../../package.json"

export function AppFooter() {
    return (
        <footer className="mt-auto border-t border-border py-4 px-4 md:px-8">
            <div className="max-w-4xl mx-auto flex justify-end">
                <Link
                    href="/changelog"
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                    v{packageJson.version}
                </Link>
            </div>
        </footer>
    )
}
