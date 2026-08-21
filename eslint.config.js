import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

const typescriptFiles = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
const scopeToTypeScript = (config) => ({ ...config, files: typescriptFiles });

export default tseslint.config(
	{
		ignores: ["backlog/**", "node_modules/**", ".idea/**"],
	},
	eslint.configs.recommended,
	...tseslint.configs.strictTypeChecked.map(scopeToTypeScript),
	...tseslint.configs.stylisticTypeChecked.map(scopeToTypeScript),
	{
		files: typescriptFiles,
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/consistent-type-exports": "error",
			"@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
			"@typescript-eslint/explicit-module-boundary-types": "error",
			"@typescript-eslint/no-unnecessary-condition": "error",
			"@typescript-eslint/strict-boolean-expressions": "error",
			"@typescript-eslint/switch-exhaustiveness-check": "error",
		},
	},
	eslintConfigPrettier,
);
