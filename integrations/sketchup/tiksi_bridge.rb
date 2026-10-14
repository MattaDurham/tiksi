# SketchUp host bridge for licensed CAD importers. Loading only adds menu commands.
# Conversion requires an empty model and aborts its import operation after export,
# so an unrelated open project can never leak into the converted file.
require 'sketchup.rb'
module TiksiBridge
  def self.convert(source, target)
    model = Sketchup.active_model
    raise ArgumentError, 'Use an empty SketchUp document for CAD conversion.' unless model.entities.empty? && model.active_entities.empty?
    raise ArgumentError, 'Choose a GLB output file.' unless File.extname(target).downcase == '.glb'
    raise ArgumentError, 'Choose an existing CAD source.' unless File.file?(source)
    model.start_operation('Tiksi CAD conversion', true)
    begin
      ok = model.import(source, { preserve_origin: true, show_summary: false })
      raise 'SketchUp could not import this CAD file.' unless ok
      raise 'SketchUp could not export GLB.' unless model.export(target, { show_summary: false })
    ensure
      model.abort_operation
    end
    target
  end
  unless file_loaded?(__FILE__)
    menu = UI.menu('Extensions').add_submenu('Tiksi')
    menu.add_item('Convert CAD file to Tiksi GLB…') do
      source = UI.openpanel('CAD source for Tiksi', nil, 'CAD|*.dwg;*.dxf;*.ifc;*.3ds||')
      if source
        target = UI.savepanel('Save Tiksi model', File.dirname(source), File.basename(source, '.*') + '.glb')
        if target
          begin
            convert(source, target)
            UI.messagebox('Saved ' + target + '. Import it in Tiksi → File.')
          rescue StandardError => error
            UI.messagebox(error.message)
          end
        end
      end
    end
    menu.add_item('Save current model for Tiksi…') do
      target = UI.savepanel('Save Tiksi model', nil, 'model.glb')
      if target
        success = Sketchup.active_model.export(target, { show_summary: false })
        UI.messagebox(success ? 'Saved ' + target : 'SketchUp could not export GLB.')
      end
    end
    file_loaded(__FILE__)
  end
end
