/** Official release archives pinned by SHA256; updates require review.
 * Cursor archive hashes were observed from the official installer URLs on
 * 2026-10-05; remaining pins were recorded on 2026-09-29. */
export const NATIVE_ASSETS = {
  "cursor": {
    "version": "2026.10.01-e373342",
    "variants": {
      "darwin/arm64": {
        "url": "https://downloads.cursor.com/lab/2026.10.01-e373342/darwin/arm64/agent-cli-package.tar.gz",
        "sha256": "629e51de43a0b7fb3b86f5ebc7e579f7df7df941b39f29e82945cde750145afc",
        "archive": true,
        "entrypoint": "dist-package/cursor-agent"
      },
      "linux/x64": {
        "url": "https://downloads.cursor.com/lab/2026.10.01-e373342/linux/x64/agent-cli-package.tar.gz",
        "sha256": "a79726c6e644520e993970be4c45775a6889802b67abe461a677a53219ae28e8",
        "archive": true,
        "entrypoint": "dist-package/cursor-agent"
      }
    }
  },
  "goose": {
    "version": "1.52.0",
    "variants": {
      "darwin/arm64": {
        "url": "https://github.com/aaif-goose/goose/releases/download/v1.52.0/goose-aarch64-apple-darwin.tar.gz",
        "sha256": "7674b0124aab685c71f8782fb7e65bac100c736ce3de0c9d3bf46ba07910e412",
        "archive": true,
        "entrypoint": "goose"
      },
      "darwin/x64": {
        "url": "https://github.com/aaif-goose/goose/releases/download/v1.52.0/goose-x86_64-apple-darwin.tar.gz",
        "sha256": "9fb8f60f36b2b2545f5e163a68c54b83c62e5c8baae4914d7aea377623a44cf9",
        "archive": true,
        "entrypoint": "goose"
      },
      "linux/arm64": {
        "url": "https://github.com/aaif-goose/goose/releases/download/v1.52.0/goose-aarch64-unknown-linux-gnu.tar.gz",
        "sha256": "ae602c4f6e9a785bf087da52c89908d4dc6aa605dcc17bf83293873f626d9c85",
        "archive": true,
        "entrypoint": "goose"
      },
      "linux/x64": {
        "url": "https://github.com/aaif-goose/goose/releases/download/v1.52.0/goose-x86_64-unknown-linux-gnu.tar.gz",
        "sha256": "4aee1f770b405c44194c0e9407df1fb06bda4c50eee935f0d8fd10731821cc5e",
        "archive": true,
        "entrypoint": "goose"
      }
    }
  },
  "crush": {
    "version": "0.97.1",
    "variants": {
      "darwin/arm64": {
        "url": "https://github.com/charmbracelet/crush/releases/download/v0.97.1/crush_0.97.1_Darwin_arm64.tar.gz",
        "sha256": "7b14a3233563390d34fa97d6e8278012d59e246793fe0a5f25a8a1c561be1666",
        "archive": true,
        "entrypoint": "crush_0.97.1_Darwin_arm64/crush"
      },
      "darwin/x64": {
        "url": "https://github.com/charmbracelet/crush/releases/download/v0.97.1/crush_0.97.1_Darwin_x86_64.tar.gz",
        "sha256": "17f6cd5238473d5906f282e45c1bb0b1f47d1e4d39431001f4d80ea4df2dfb2b",
        "archive": true,
        "entrypoint": "crush_0.97.1_Darwin_x86_64/crush"
      },
      "linux/arm64": {
        "url": "https://github.com/charmbracelet/crush/releases/download/v0.97.1/crush_0.97.1_Linux_arm64.tar.gz",
        "sha256": "16c9477a178d69e02a51bf4babe6174e62051314b2cd7f36b1ec5fea47e25a88",
        "archive": true,
        "entrypoint": "crush_0.97.1_Linux_arm64/crush"
      },
      "linux/x64": {
        "url": "https://github.com/charmbracelet/crush/releases/download/v0.97.1/crush_0.97.1_Linux_x86_64.tar.gz",
        "sha256": "1b7cbe0600a3797538a74dc00dd8c4bac54ac4b8f4455ba5ff2312b29c7bd598",
        "archive": true,
        "entrypoint": "crush_0.97.1_Linux_x86_64/crush"
      }
    }
  },
  "open-interpreter": {
    "version": "0.0.45",
    "variants": {
      "darwin/arm64": {
        "url": "https://github.com/openinterpreter/openinterpreter/releases/download/rust-v0.0.45/open-interpreter-package-aarch64-apple-darwin.tar.gz",
        "sha256": "ef48dee730bdb26fb9f5e3494c6246a60ae225ba1d58b1f4aca01037c3645f4f",
        "archive": true,
        "entrypoint": "bin/interpreter"
      },
      "darwin/x64": {
        "url": "https://github.com/openinterpreter/openinterpreter/releases/download/rust-v0.0.45/open-interpreter-package-x86_64-apple-darwin.tar.gz",
        "sha256": "65af1b3d18175bd0c3b133b97e280b1bd8886d549e8fc2119e1eaa762343619e",
        "archive": true,
        "entrypoint": "bin/interpreter"
      },
      "linux/arm64": {
        "url": "https://github.com/openinterpreter/openinterpreter/releases/download/rust-v0.0.45/open-interpreter-package-aarch64-unknown-linux-musl.tar.gz",
        "sha256": "d88bfa70b31155ed24cbff2ed7ce355bbc2362f2f993c5998e0015274a754a13",
        "archive": true,
        "entrypoint": "bin/interpreter"
      },
      "linux/x64": {
        "url": "https://github.com/openinterpreter/openinterpreter/releases/download/rust-v0.0.45/open-interpreter-package-x86_64-unknown-linux-musl.tar.gz",
        "sha256": "9312213f6d7bed2e3f2026889579d861635e50fc1289382aac2a1af7fab0a087",
        "archive": true,
        "entrypoint": "bin/interpreter"
      }
    }
  },
  "droid": {
    "version": "0.229.0",
    "variants": {
      "darwin/arm64": {
        "url": "https://downloads.factory.ai/factory-cli/releases/0.229.0/darwin/arm64/droid",
        "sha256": "37f3a7e0e65807596d71cc77c77857eddb28ef5f26eb1c3af92cf0d95ab6b4a8",
        "archive": false,
        "entrypoint": "droid"
      },
      "darwin/x64": {
        "url": "https://downloads.factory.ai/factory-cli/releases/0.229.0/darwin/x64/droid",
        "sha256": "19f78c3466d3d06fedd8c32b734b0367a174f61f6c3232bc6863d1fe7475be76",
        "archive": false,
        "entrypoint": "droid"
      },
      "linux/arm64": {
        "url": "https://downloads.factory.ai/factory-cli/releases/0.229.0/linux/arm64/droid",
        "sha256": "6f6e5fc09b40c84fdc1670f417a7fe56d695acc9dd4fd40d2bd4a16b0549f979",
        "archive": false,
        "entrypoint": "droid"
      },
      "linux/x64": {
        "url": "https://downloads.factory.ai/factory-cli/releases/0.229.0/linux/x64/droid",
        "sha256": "9d27659982a88c4ee3d719b5b3299a5a0c02d5f9d02f1aa9a592cf3f3fb2b7a5",
        "archive": false,
        "entrypoint": "droid"
      }
    }
  }
} as const;
