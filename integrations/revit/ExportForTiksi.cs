using System;
using System.IO;
using System.Windows.Forms;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace Tiksi.Revit;

[Transaction(TransactionMode.Manual)]
public class ExportForTiksi : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        Document document = commandData.Application.ActiveUIDocument?.Document;
        if (document == null) return Result.Cancelled;
        using var picker = new SaveFileDialog { Filter = "IFC model|*.ifc", FileName = document.Title + ".ifc" };
        if (picker.ShowDialog() != DialogResult.OK) return Result.Cancelled;
        try
        {
            // IFC export uses a transaction; rolling it back preserves the source project.
            using var transaction = new Transaction(document, "Export for Tiksi");
            transaction.Start();
            var options = new IFCExportOptions { FileVersion = IFCVersion.IFC4 };
            options.AddOption("ExportBaseQuantities", "true");
            options.AddOption("ExportInternalRevitPropertySets", "true");
            options.AddOption("ExportIFCCommonPropertySets", "true");
            bool success = document.Export(Path.GetDirectoryName(picker.FileName), Path.GetFileName(picker.FileName), options);
            transaction.RollBack();
            if (!success) { message = "Revit IFC exporter did not produce a model."; return Result.Failed; }
            TaskDialog.Show("Tiksi", "Saved IFC geometry, IDs, materials and properties. Import this file in Tiksi → File.");
            return Result.Succeeded;
        }
        catch (Exception error) { message = error.Message; return Result.Failed; }
    }
}
