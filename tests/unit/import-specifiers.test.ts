import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../..");

test("relative module specifiers resolve directly to TypeScript files", () => {
  const violations: string[] = [];
  for (const directory of ["src", "tests", "scripts"]) {
    for (const entry of readdirSync(resolve(root, directory), {
      recursive: true,
      encoding: "utf8",
    })) {
      if (!entry.endsWith(".ts")) continue;
      const path = resolve(root, directory, entry);
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true
      );
      const visit = (node: ts.Node): void => {
        const specifier = moduleSpecifier(node);
        if (specifier && /^\.\.?\//.test(specifier.text)) {
          if (
            !specifier.text.endsWith(".ts") ||
            !existsSync(resolve(dirname(path), specifier.text))
          ) {
            violations.push(`${directory}/${entry}: ${specifier.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  expect(violations).toEqual([]);
});

/** Find literal module references, including lazy imports and module mocks. */
function moduleSpecifier(node: ts.Node): ts.StringLiteralLike | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
      ? node.moduleSpecifier
      : undefined;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return ts.isStringLiteralLike(node.argument.literal) ? node.argument.literal : undefined;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText();
    const argument = node.arguments[0];
    if (
      ["import", "require", "mock.module"].includes(callee) &&
      argument &&
      ts.isStringLiteralLike(argument)
    ) {
      return argument;
    }
  }
  return undefined;
}
