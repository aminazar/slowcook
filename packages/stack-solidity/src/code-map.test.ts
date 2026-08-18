// Solidity code map. The scanner is regex-based over blanked source, so the
// tests that matter most are the ones a naive regex gets WRONG: declarations
// inside comments and strings, and nested/sequential contracts.
import { describe, it, expect } from "vitest";
import { blankNonCode, scanSolidityFile, summarizeContracts } from "./code-map.js";

const SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "./IERC20.sol";

/// @notice Fungible IOU issued by a pool.
interface IIouToken {
    event Transfer(address indexed from, address indexed to, uint256 value);
    error NotPool(address caller);
    function mint(address to, uint256 amount) external;
    function balanceOf(address who) external view returns (uint256);
}

/**
 * @title IouToken
 * @notice Pool-issued IOU with EIP-3009 authorization.
 */
contract IouToken is IIouToken, Ownable {
    error Unauthorized();
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    modifier onlyPool() {
        _;
    }

    constructor(address pool_) {
        pool = pool_;
    }

    function mint(address to, uint256 amount) external onlyPool {
        _mint(to, amount);
    }

    function balanceOf(address who) public view returns (uint256) {
        return _balances[who];
    }

    function _mint(address to, uint256 amount) internal {
        _balances[to] += amount;
    }

    receive() external payable {}
}

library AuthLib {
    function recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        return address(0);
    }
}

abstract contract Base {
    function hook() internal virtual;
}
`;

describe("blankNonCode", () => {
  it("keeps offsets stable so line numbers survive blanking", () => {
    const src = 'a\n// comment\n"str"\nb';
    const out = blankNonCode(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
  });

  it("blanks line comments, block comments and string literals", () => {
    const out = blankNonCode('x // contract Ghost {\n/* contract Spectre { */\ny = "contract Phantom {";');
    expect(out).not.toContain("Ghost");
    expect(out).not.toContain("Spectre");
    expect(out).not.toContain("Phantom");
  });

  it("does not treat // inside a string as a comment", () => {
    const out = blankNonCode('string memory u = "https://x.dev"; uint256 real;');
    expect(out).toContain("real");           // code after the string survives
  });

  it("handles an escaped quote without swallowing the rest of the file", () => {
    const out = blankNonCode('revert("say \\"hi\\""); contract Real {');
    expect(out).toContain("contract Real");
  });
});

describe("scanSolidityFile", () => {
  const found = scanSolidityFile(SRC, "src/IouToken.sol");
  const byName = (n: string) => found.find((c) => c.name === n)!;

  it("finds every declaration kind", () => {
    expect(found.map((c) => c.name)).toEqual(["IIouToken", "IouToken", "AuthLib", "Base"]);
    expect(byName("IIouToken").kind).toBe("interface");
    expect(byName("IouToken").kind).toBe("contract");
    expect(byName("AuthLib").kind).toBe("library");
    expect(byName("Base").kind).toBe("abstract contract");
  });

  it("records the inheritance list — what an agent must satisfy", () => {
    expect(byName("IouToken").inherits).toEqual(["IIouToken", "Ownable"]);
    expect(byName("AuthLib").inherits).toEqual([]);
  });

  it("captures functions with visibility and mutability", () => {
    const fns = byName("IouToken").functions;
    expect(fns.find((f) => f.name === "mint")).toMatchObject({ visibility: "external", mutability: "" });
    expect(fns.find((f) => f.name === "balanceOf")).toMatchObject({ visibility: "public", mutability: "view" });
    expect(fns.find((f) => f.name === "_mint")).toMatchObject({ visibility: "internal" });
    expect(fns.find((f) => f.name === "receive")).toMatchObject({ mutability: "payable" });
    expect(fns.map((f) => f.name)).toContain("constructor");
  });

  it("keeps each member with its OWN contract, not the file", () => {
    expect(byName("IIouToken").functions.map((f) => f.name)).toEqual(["mint", "balanceOf"]);
    expect(byName("AuthLib").functions.map((f) => f.name)).toEqual(["recover"]);
    expect(byName("Base").functions.map((f) => f.name)).toEqual(["hook"]);
  });

  it("captures events, custom errors and modifiers", () => {
    expect(byName("IouToken").events).toEqual(["AuthorizationUsed"]);
    expect(byName("IouToken").errors).toEqual(["Unauthorized"]);
    expect(byName("IouToken").modifiers).toEqual(["onlyPool"]);
    expect(byName("IIouToken").errors).toEqual(["NotPool"]);
  });

  it("reports 1-based lines that point at the real declaration", () => {
    const c = byName("IouToken");
    expect(SRC.split("\n")[c.line - 1]).toContain("contract IouToken is");
    const mint = c.functions.find((f) => f.name === "mint")!;
    expect(SRC.split("\n")[mint.line - 1]).toContain("function mint(");
  });

  it("picks up natspec above the declaration", () => {
    expect(byName("IIouToken").natspec).toContain("Fungible IOU");
    expect(byName("IouToken").natspec).toContain("EIP-3009");
  });

  it("ignores declarations that live in comments or strings", () => {
    const tricky = `
// contract CommentedOut {}
/* library BlockedOut {} */
contract Real {
    function f() external {
        revert("contract StringOnly {");
    }
}
`;
    expect(scanSolidityFile(tricky, "a.sol").map((c) => c.name)).toEqual(["Real"]);
  });

  it("returns nothing for a file with no declarations", () => {
    expect(scanSolidityFile("pragma solidity ^0.8.20;\n", "empty.sol")).toEqual([]);
  });

  it("survives an unterminated block without hanging or throwing", () => {
    expect(() => scanSolidityFile("contract Broken {\n  function f() external {", "b.sol")).not.toThrow();
    expect(scanSolidityFile("contract Broken {\n  function f() external {", "b.sol")[0]!.name).toBe("Broken");
  });

  it("drops constructor arguments from an inheritance entry", () => {
    const s = "contract C is Base(1, 2), Other {}";
    expect(scanSolidityFile(s, "c.sol")[0]!.inherits).toEqual(["Base", "Other"]);
  });
});

describe("summarizeContracts", () => {
  it("counts by kind for the run log", () => {
    const s = summarizeContracts(scanSolidityFile(SRC, "x.sol"));
    expect(s).toContain("2 contracts");     // IouToken + abstract Base
    expect(s).toContain("1 interfaces");
    expect(s).toContain("1 libraries");
  });
});
