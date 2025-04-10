#!/bin/bash

script_dir=$(realpath "$(dirname "$0")")

# Navigate up one directory to reach the parent directory
parent_dir=$(dirname "$script_dir")

# Source directories
typechain_types_dir="$parent_dir/typechain"

# Destination directory
package_dir="$parent_dir/wxtm-bridge-contracts-typechain"

cp -r "$typechain_types_dir" "$package_dir"
