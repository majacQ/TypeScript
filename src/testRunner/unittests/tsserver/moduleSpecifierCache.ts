import * as ts from "../../_namespaces/ts";
import {
    createServerHost,
    File,
    SymLink,
    TestServerHost,
} from "../virtualFileSystemWithWatch";
import {
    baselineTsserverLogs,
    configuredProjectAt,
    createLoggerWithInMemoryLogs,
    createSession,
    executeSessionRequest,
    Logger,
    openFilesForSession,
} from "./helpers";

const packageJson: File = {
    path: "/package.json",
    content: `{ "dependencies": { "mobx": "*" } }`
};
const aTs: File = {
    path: "/src/a.ts",
    content: "export const foo = 0;",
};
const bTs: File = {
    path: "/src/b.ts",
    content: "foo",
};
const cTs: File = {
    path: "/src/c.ts",
    content: "import ",
};
const bSymlink: SymLink = {
    path: "/src/b-link.ts",
    symLink: "./b.ts",
};
const tsconfig: File = {
    path: "/tsconfig.json",
    content: `{ "include": ["src"] }`,
};
const ambientDeclaration: File = {
    path: "/src/ambient.d.ts",
    content: "declare module 'ambient' {}"
};
const mobxPackageJson: File = {
    path: "/node_modules/mobx/package.json",
    content: `{ "name": "mobx", "version": "1.0.0" }`
};
const mobxDts: File = {
    path: "/node_modules/mobx/index.d.ts",
    content: "export declare function observable(): unknown;"
};

describe("unittests:: tsserver:: moduleSpecifierCache", () => {
    it("caches importability within a file", () => {
        const { moduleSpecifierCache } = setup();
        assert.isFalse(moduleSpecifierCache.get(bTs.path as ts.Path, aTs.path as ts.Path, {}, {})?.isBlockedByPackageJsonDependencies);
    });

    it("caches module specifiers within a file", () => {
        const { moduleSpecifierCache, triggerCompletions } = setup();
        // Completion at an import statement will calculate and cache module specifiers
        triggerCompletions({ file: cTs.path, line: 1, offset: cTs.content.length + 1 });
        const mobxCache = moduleSpecifierCache.get(cTs.path as ts.Path, mobxDts.path as ts.Path, {}, {});
        assert.deepEqual(mobxCache, {
            modulePaths: [{
                path: mobxDts.path,
                isInNodeModules: true,
                isRedirect: false
            }],
            moduleSpecifiers: ["mobx"],
            isBlockedByPackageJsonDependencies: false,
        });
    });

    it("invalidates module specifiers when changes happen in contained node_modules directories", () => {
        const { host, session, moduleSpecifierCache, triggerCompletions } = setup(host => createLoggerWithInMemoryLogs(host));
        // Completion at an import statement will calculate and cache module specifiers
        triggerCompletions({ file: cTs.path, line: 1, offset: cTs.content.length + 1 });
        host.writeFile("/node_modules/.staging/mobx-12345678/package.json", "{}");
        host.runQueuedTimeoutCallbacks();
        assert.equal(moduleSpecifierCache.count(), 0);
        baselineTsserverLogs("moduleSpecifierCache", "invalidates module specifiers when changes happen in contained node_modules directories", session);
    });

    it("does not invalidate the cache when new files are added", () => {
        const { host, moduleSpecifierCache } = setup();
        host.writeFile("/src/a2.ts", aTs.content);
        host.runQueuedTimeoutCallbacks();
        assert.isFalse(moduleSpecifierCache.get(bTs.path as ts.Path, aTs.path as ts.Path, {}, {})?.isBlockedByPackageJsonDependencies);
    });

    it("invalidates the cache when symlinks are added or removed", () => {
        const { host, moduleSpecifierCache } = setup();
        host.renameFile(bSymlink.path, "/src/b-link2.ts");
        host.runQueuedTimeoutCallbacks();
        assert.equal(moduleSpecifierCache.count(), 0);
    });

    it("invalidates the cache when local package.json changes", () => {
        const { host, moduleSpecifierCache } = setup();
        host.writeFile("/package.json", `{}`);
        host.runQueuedTimeoutCallbacks();
        assert.equal(moduleSpecifierCache.count(), 0);
    });

    it("invalidates the cache when module resolution settings change", () => {
        const { host, moduleSpecifierCache } = setup();
        host.writeFile(tsconfig.path, `{ "compilerOptions": { "moduleResolution": "classic" }, "include": ["src"] }`);
        host.runQueuedTimeoutCallbacks();
        assert.equal(moduleSpecifierCache.count(), 0);
    });

    it("invalidates the cache when user preferences change", () => {
        const { moduleSpecifierCache, session, triggerCompletions } = setup();
        const preferences: ts.UserPreferences = { importModuleSpecifierPreference: "project-relative" };

        assert.ok(getWithPreferences({}));
        executeSessionRequest<ts.server.protocol.ConfigureRequest, ts.server.protocol.ConfigureResponse>(session, ts.server.protocol.CommandTypes.Configure, { preferences });
        // Nothing changes yet
        assert.ok(getWithPreferences({}));
        assert.isUndefined(getWithPreferences(preferences));
        // Completions will request (getting nothing) and set the cache with new preferences
        triggerCompletions({ file: bTs.path, line: 1, offset: 3 });
        assert.isUndefined(getWithPreferences({}));
        assert.ok(getWithPreferences(preferences));

        // Test other affecting preference
        executeSessionRequest<ts.server.protocol.ConfigureRequest, ts.server.protocol.ConfigureResponse>(session, ts.server.protocol.CommandTypes.Configure, {
            preferences: { importModuleSpecifierEnding: "js" },
        });
        triggerCompletions({ file: bTs.path, line: 1, offset: 3 });
        assert.isUndefined(getWithPreferences(preferences));

        function getWithPreferences(preferences: ts.UserPreferences) {
            return moduleSpecifierCache.get(bTs.path as ts.Path, aTs.path as ts.Path, preferences, {});
        }
    });
});

function setup(createLogger?: (host: TestServerHost) => Logger) {
    const host = createServerHost([aTs, bTs, cTs, bSymlink, ambientDeclaration, tsconfig, packageJson, mobxPackageJson, mobxDts]);
    const session = createSession(host, createLogger && { logger: createLogger(host) });
    openFilesForSession([aTs, bTs, cTs], session);
    const projectService = session.getProjectService();
    const project = configuredProjectAt(projectService, 0);
    executeSessionRequest<ts.server.protocol.ConfigureRequest, ts.server.protocol.ConfigureResponse>(session, ts.server.protocol.CommandTypes.Configure, {
        preferences: {
            includeCompletionsForImportStatements: true,
            includeCompletionsForModuleExports: true,
            includeCompletionsWithInsertText: true,
            includeCompletionsWithSnippetText: true,
        },
    });
    triggerCompletions({ file: bTs.path, line: 1, offset: 3 });

    return { host, project, projectService, session, moduleSpecifierCache: project.getModuleSpecifierCache(), triggerCompletions };

    function triggerCompletions(requestLocation: ts.server.protocol.FileLocationRequestArgs) {
        executeSessionRequest<ts.server.protocol.CompletionsRequest, ts.server.protocol.CompletionInfoResponse>(session, ts.server.protocol.CommandTypes.CompletionInfo, {
            ...requestLocation,
        });
    }
}
