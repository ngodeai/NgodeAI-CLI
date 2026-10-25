{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.ngodeai;
in
{
  options.programs.ngodeai = {
    enable = lib.mkEnableOption "NGODEAI coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.ngodeai.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "NGODEAI package to install system-wide.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}
